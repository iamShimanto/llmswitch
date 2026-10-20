/**
 * Google Vertex AI executor — chat via the Vertex OpenAI-compatible endpoint.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) —
 * `open-sse/config/providers/registry/vertex/index.ts` (provider shape +
 * model seed) and `open-sse/executors/vertex.ts` (service-account JWT
 * bootstrap, OAuth scopes, endpoint families). Attribution retained.
 *
 * Auth flow (Google service-account JWT bearer grant, RFC 7523):
 *   1. Build an RS256 JWT: iss/sub = SA client_email, aud =
 *      https://oauth2.googleapis.com/token, scope = cloud-platform (+ the
 *      generative-language.retriever scope OmniRoute mints), kid =
 *      private_key_id. Signed here with `node:crypto` (OmniRoute uses the
 *      `jose` package; LLMSwitch adds no dependency).
 *   2. POST https://oauth2.googleapis.com/token with
 *      grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer → access_token.
 *   3. POST the token as Bearer to the OpenAI-compatible endpoint:
 *      https://<region>-aiplatform.googleapis.com/v1/projects/<project>/
 *        locations/<region>/endpoints/openapi/chat/completions
 *      (host is plain aiplatform.googleapis.com for the "global" location).
 *
 * Credentials come from the environment only:
 *   GOOGLE_APPLICATION_CREDENTIALS  — path to a service-account JSON key file
 *   VERTEX_SERVICE_ACCOUNT_JSON     — the SA JSON inline (or a file path)
 *   VERTEX_CLIENT_EMAIL + VERTEX_PRIVATE_KEY (+ VERTEX_PRIVATE_KEY_ID)
 *   VERTEX_PROJECT_ID (defaults to the SA JSON's project_id)
 *   VERTEX_REGION / VERTEX_LOCATION (default us-central1)
 *   VERTEX_ACCESS_TOKEN             — escape hatch: a pre-minted access token
 *                                     (skips the JWT exchange entirely)
 *
 * What this port DROPS vs OmniRoute: the native Gemini generateContent
 * route and the Anthropic/Mistral rawPredict routes. Every model goes
 * through the single OpenAI-compatible endpoint above, which is the route
 * GCP documents for both Gemini and MaaS partner models on Vertex.
 */

import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** OAuth scopes minted into the Vertex SA token (from OmniRoute). */
export const VERTEX_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever",
] as const;

export interface VertexServiceAccount {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  projectId?: string;
}

export interface VertexConfig {
  projectId: string;
  region: string;
  serviceAccount?: VertexServiceAccount;
  accessToken?: string;
}

/** Typed auth error the router surfaces as a non-retryable auth failure. */
export class VertexAuthError extends UpstreamError {
  constructor(message: string) {
    super("auth_error", 401, message);
    this.name = "VertexAuthError";
  }
}

const NO_CREDS_MSG =
  "vertex: no credentials — set GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path), " +
  "VERTEX_SERVICE_ACCOUNT_JSON, or VERTEX_CLIENT_EMAIL + VERTEX_PRIVATE_KEY";

function parseServiceAccountJson(raw: string, origin: string): VertexServiceAccount {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VertexAuthError(`vertex: service account JSON from ${origin} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || parsed.web || parsed.installed) {
    throw new VertexAuthError(
      "vertex: an OAuth client JSON is not a service account key — create a service account JSON key in GCP",
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new VertexAuthError("vertex: service account JSON is missing client_email or private_key");
  }
  return {
    clientEmail: String(parsed.client_email),
    privateKey: String(parsed.private_key),
    privateKeyId: parsed.private_key_id ? String(parsed.private_key_id) : undefined,
    projectId: parsed.project_id ? String(parsed.project_id) : undefined,
  };
}

export function hasVertexCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.VERTEX_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.VERTEX_SERVICE_ACCOUNT_JSON ?? "").trim()) return true;
  const gac = (env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
  if (gac && existsSync(gac)) return true;
  return Boolean((env.VERTEX_CLIENT_EMAIL ?? "").trim() && (env.VERTEX_PRIVATE_KEY ?? "").trim());
}

export function resolveVertexConfig(env: NodeJS.ProcessEnv = process.env): VertexConfig {
  const region = (env.VERTEX_REGION ?? env.VERTEX_LOCATION ?? "").trim() || "us-central1";
  const envProject = (env.VERTEX_PROJECT_ID ?? "").trim();

  const accessToken = (env.VERTEX_ACCESS_TOKEN ?? "").trim();
  if (accessToken) {
    if (!envProject) {
      throw new VertexAuthError("vertex: VERTEX_ACCESS_TOKEN is set but VERTEX_PROJECT_ID is missing");
    }
    return { projectId: envProject, region, accessToken };
  }

  let sa: VertexServiceAccount | undefined;
  const inline = (env.VERTEX_SERVICE_ACCOUNT_JSON ?? "").trim();
  if (inline) {
    sa = inline.startsWith("{")
      ? parseServiceAccountJson(inline, "VERTEX_SERVICE_ACCOUNT_JSON")
      : parseServiceAccountJson(readFileSync(inline, "utf8"), inline);
  } else {
    const gac = (env.GOOGLE_APPLICATION_CREDENTIALS ?? "").trim();
    if (gac && existsSync(gac)) {
      sa = parseServiceAccountJson(readFileSync(gac, "utf8"), gac);
    } else if ((env.VERTEX_CLIENT_EMAIL ?? "").trim() && (env.VERTEX_PRIVATE_KEY ?? "").trim()) {
      sa = {
        clientEmail: (env.VERTEX_CLIENT_EMAIL as string).trim(),
        // env-provided PEMs often carry literal "\n" escapes
        privateKey: (env.VERTEX_PRIVATE_KEY as string).replace(/\\n/g, "\n"),
        privateKeyId: (env.VERTEX_PRIVATE_KEY_ID ?? "").trim() || undefined,
      };
    }
  }
  if (!sa) throw new VertexAuthError(NO_CREDS_MSG);

  const projectId = envProject || sa.projectId;
  if (!projectId) {
    throw new VertexAuthError("vertex: no project id — set VERTEX_PROJECT_ID (the SA JSON has no project_id)");
  }
  return { projectId, region, serviceAccount: sa };
}

/* ------------------------------------------------------------------ *
 * Service-account JWT (RS256, node:crypto)
 * ------------------------------------------------------------------ */

function base64url(data: string | Buffer): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface VertexJwtParts {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  jwt: string;
}

/** Build + sign the SA JWT. Pure given (sa, nowSeconds) — unit-testable. */
export function buildVertexJwt(sa: VertexServiceAccount, nowSeconds: number): VertexJwtParts {
  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (sa.privateKeyId) header.kid = sa.privateKeyId;
  const claims: Record<string, unknown> = {
    iss: sa.clientEmail,
    sub: sa.clientEmail,
    aud: GOOGLE_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    scope: VERTEX_OAUTH_SCOPES.join(" "),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.privateKey);
  return { header, claims, jwt: `${signingInput}.${base64url(signature)}` };
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Exchange the SA JWT for an OAuth access token (cached per SA email). */
export async function getVertexAccessToken(
  sa: VertexServiceAccount,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const cached = tokenCache.get(sa.clientEmail);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

  const { jwt } = buildVertexJwt(sa, Math.floor(Date.now() / 1000));
  const res = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new VertexAuthError(`vertex: token exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!data?.access_token) throw new VertexAuthError("vertex: token exchange returned no access_token");
  const minted = data.access_token;
  tokenCache.set(sa.clientEmail, Object.assign(
    { expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 },
    { token: minted },
  ));
  return minted;
}

/** Clear the in-memory token cache (tests). */
export function clearVertexTokenCache(): void {
  tokenCache.clear();
}

/* ------------------------------------------------------------------ *
 * Execution (Vertex OpenAI-compatible endpoint)
 * ------------------------------------------------------------------ */

export function vertexChatUrl(projectId: string, region: string): string {
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${projectId}/locations/${region}/endpoints/openapi/chat/completions`;
}

async function* vertexSsePassthrough(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch {
          /* ignore malformed SSE lines */
        }
      }
    }
  }
}

/**
 * Gateway path: resolve env creds (SA JWT → access token, or a pre-minted
 * VERTEX_ACCESS_TOKEN), then POST the OpenAI-wire request to Vertex.
 * Used by the router when provider.id === "vertex".
 */
export async function executeVertexChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const cfg = resolveVertexConfig(env);
  const started = Date.now();
  const accessToken = cfg.accessToken ?? (await getVertexAccessToken(cfg.serviceAccount!, fetchFn));
  const url = vertexChatUrl(cfg.projectId, cfg.region);
  const stream = body.stream === true;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, model, stream }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `vertex network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new VertexAuthError(`vertex auth failed (HTTP ${res.status}): ${text.slice(0, 200)} — check the service account and project`);
    }
    throw new UpstreamError(classifyStatus(res.status), res.status, `vertex upstream ${res.status}: ${text.slice(0, 300)}`);
  }

  const latencyMs = Date.now() - started;
  if (stream) {
    if (!res.body) {
      clearTimeout(timer);
      throw new UpstreamError("server_error", res.status, "vertex: empty stream body");
    }
    const gen = (async function* () {
      try {
        yield* vertexSsePassthrough(res.body!.getReader());
      } finally {
        clearTimeout(timer);
        try {
          await res.body!.cancel();
        } catch {
          /* noop */
        }
      }
    })();
    return { stream: gen, providerId: "vertex", model, latencyMs, quota: null };
  }

  clearTimeout(timer);
  const json = (await res.json().catch(() => null)) as ChatCompletionResponse | null;
  if (!json) throw new UpstreamError("server_error", res.status, "vertex: invalid JSON from upstream");
  return { response: json, providerId: "vertex", model, latencyMs, quota: null };
}
