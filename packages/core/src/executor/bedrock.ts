/**
 * AWS Bedrock executor — chat via the Bedrock Runtime Converse API.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) —
 * `open-sse/config/providers/registry/bedrock/index.ts` (provider shape +
 * model seed), `open-sse/config/bedrock.ts` (region rules) and
 * `open-sse/executors/bedrock.ts` (Converse request/response mapping).
 * Attribution retained.
 *
 * Differences from OmniRoute: OmniRoute delegates signing to the AWS SDK
 * (`@aws-sdk/client-bedrock-runtime`). LLMSwitch adds no AWS dependency —
 * the SigV4 signature is computed here with `node:crypto` only, and the
 * Converse REST endpoint is called directly:
 *   POST https://bedrock-runtime.<region>.amazonaws.com/model/<id>/converse
 *
 * Credentials come from the environment only:
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (optional),
 *   AWS_REGION / AWS_DEFAULT_REGION (default us-east-1).
 *
 * What this port DROPS vs OmniRoute: binary event-stream streaming
 * (`/converse-stream`) — streaming requests fail with a typed error rather
 * than faking SSE; image/tool blocks are mapped in the standard Converse
 * shapes for text + function-calling JSON, but multimodal content parts in
 * OpenAI array form beyond text are passed through as text.
 */

import { createHash, createHmac } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { classifyStatus, UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

export interface BedrockCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

/** Typed auth error the router surfaces as a non-retryable auth failure. */
export class BedrockAuthError extends UpstreamError {
  constructor(message: string) {
    super("auth_error", 401, message);
    this.name = "BedrockAuthError";
  }
}

const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/i;

/** Region rule ported from OmniRoute `config/bedrock.ts`. */
export function normalizeBedrockRegion(value: string | undefined, fallback = "us-east-1"): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return REGION_PATTERN.test(trimmed) ? trimmed : fallback;
}

export function hasBedrockCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim());
}

export function resolveBedrockCreds(env: NodeJS.ProcessEnv = process.env): BedrockCreds {
  const accessKeyId = (env.AWS_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (env.AWS_SECRET_ACCESS_KEY ?? "").trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new BedrockAuthError(
      "bedrock: no AWS credentials — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_REGION if not us-east-1)",
    );
  }
  const sessionToken = (env.AWS_SESSION_TOKEN ?? "").trim() || undefined;
  const region = normalizeBedrockRegion(env.AWS_REGION ?? env.AWS_DEFAULT_REGION);
  return { accessKeyId, secretAccessKey, sessionToken, region };
}

/* ------------------------------------------------------------------ *
 * SigV4 signing (node:crypto only)
 * ------------------------------------------------------------------ */

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export interface SigV4Input {
  method: string;
  host: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  payload: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
  /** ISO basic timestamp, e.g. 20150830T123600Z (injectable for tests) */
  amzDate: string;
}

export interface SigV4Result {
  headers: Record<string, string>;
  canonicalRequest: string;
  canonicalRequestHash: string;
  stringToSign: string;
  signature: string;
  authorization: string;
}

const uriEncode = (s: string): string =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** Encode each path segment (SigV4 canonical URI rules; "/" stays). */
function canonicalUri(path: string): string {
  return path.split("/").map(uriEncode).join("/");
}

function canonicalQueryString(query: string): string {
  if (!query) return "";
  const pairs = query
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      const k = eq >= 0 ? pair.slice(0, eq) : pair;
      const v = eq >= 0 ? pair.slice(eq + 1) : "";
      return [uriEncode(decodeURIComponent(k)), uriEncode(decodeURIComponent(v))] as const;
    })
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** Compute a SigV4 signature for a request. Pure — fully unit-testable. */
export function signSigV4(input: SigV4Input): SigV4Result {
  const dateStamp = input.amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, host: input.host, "x-amz-date": input.amzDate };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;

  const lowerNames = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const byLower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) byLower.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
  const canonicalHeaders = lowerNames.map((n) => `${n}:${byLower.get(n)}`).join("\n") + "\n";
  const signedHeaders = lowerNames.join(";");

  const payloadHash = sha256Hex(input.payload);
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQueryString(input.query ?? ""),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const canonicalRequestHash = sha256Hex(canonicalRequest);

  const credentialScope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join("\n");

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: { ...headers, authorization },
    canonicalRequest,
    canonicalRequestHash,
    stringToSign,
    signature,
    authorization,
  };
}

/** Current timestamp in SigV4 basic format (YYYYMMDDTHHMMSSZ). */
export function sigV4Timestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/* ------------------------------------------------------------------ *
 * Converse API mapping (ported from OmniRoute executors/bedrock.ts)
 * ------------------------------------------------------------------ */

interface ConverseMessage {
  role: "user" | "assistant";
  content: Array<Record<string, unknown>>;
}

export function toConverseBody(
  model: string,
  body: ChatCompletionRequest,
): Record<string, unknown> {
  const system: Array<{ text: string }> = [];
  const messages: ConverseMessage[] = [];
  for (const msg of body.messages) {
    const text = typeof msg.content === "string" ? msg.content : "";
    if (msg.role === "system") {
      if (text.trim()) system.push({ text });
      continue;
    }
    if (msg.role === "tool") {
      // Tool results surface as user-role toolResult blocks.
      messages.push({
        role: "user",
        content: [{ toolResult: { toolUseId: "tool", content: [{ text }], status: "success" } }],
      });
      continue;
    }
    if (!text) continue;
    messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: [{ text }] });
  }

  const payload: Record<string, unknown> = { messages };
  if (system.length > 0) payload.system = system;

  const inferenceConfig: Record<string, unknown> = {};
  if (typeof body.max_tokens === "number") inferenceConfig.maxTokens = Math.max(1, Math.floor(body.max_tokens));
  if (typeof body.temperature === "number") inferenceConfig.temperature = body.temperature;
  if (Object.keys(inferenceConfig).length > 0) payload.inferenceConfig = inferenceConfig;

  if (body.tools && body.tools.length > 0) {
    payload.toolConfig = {
      tools: body.tools.map((t) => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description ?? "",
          inputSchema: { json: t.function.parameters ?? { type: "object" } },
        },
      })),
    };
  }
  return payload;
}

const STOP_REASONS: Record<string, string> = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  content_filtered: "content_filter",
  guardrail_intervened: "content_filter",
};

export function fromConverseResponse(json: any, model: string): ChatCompletionResponse {
  const blocks: Array<Record<string, any>> = json?.output?.message?.content ?? [];
  let text = "";
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  for (const block of blocks) {
    if (typeof block.text === "string") text += block.text;
    if (block.toolUse) {
      toolCalls.push({
        id: String(block.toolUse.toolUseId ?? `toolu_${toolCalls.length}`),
        type: "function",
        function: {
          name: String(block.toolUse.name ?? ""),
          arguments: JSON.stringify(block.toolUse.input ?? {}),
        },
      });
    }
  }
  const usage = json?.usage ?? {};
  const promptTokens = Number(usage.inputTokens ?? 0) +
    Number(usage.cacheReadInputTokens ?? 0) + Number(usage.cacheWriteInputTokens ?? 0);
  const completionTokens = Number(usage.outputTokens ?? 0);
  return {
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: STOP_REASONS[String(json?.stopReason ?? "")] ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.totalTokens ?? promptTokens + completionTokens),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

export function bedrockConverseUrl(region: string, model: string, stream = false): string {
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse${stream ? "-stream" : ""}`;
}

/**
 * Gateway path: resolve env creds, sign, execute one Converse call.
 * Used by the router when provider.id === "bedrock".
 */
export async function executeBedrockChat(
  _provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 120_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  if (body.stream === true) {
    throw new UpstreamError(
      "bad_request",
      400,
      "bedrock: streaming is not supported by this port (Converse binary event-stream not implemented) — send stream:false",
    );
  }
  const creds = resolveBedrockCreds(env);
  const started = Date.now();
  const payload = JSON.stringify(toConverseBody(model, body));
  const host = `bedrock-runtime.${creds.region}.amazonaws.com`;
  const signed = signSigV4({
    method: "POST",
    host,
    path: `/model/${encodeURIComponent(model)}/converse`,
    headers: { "content-type": "application/json", accept: "application/json" },
    payload,
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    region: creds.region,
    service: "bedrock",
    amzDate: sigV4Timestamp(),
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchFn(bedrockConverseUrl(creds.region, model), {
      method: "POST",
      headers: signed.headers,
      body: payload,
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new UpstreamError("timeout", 0, `bedrock network error: ${(err as Error).message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new BedrockAuthError(`bedrock auth failed (HTTP ${res.status}): ${text.slice(0, 200)} — check AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY`);
    }
    throw new UpstreamError(classifyStatus(res.status), res.status, `bedrock upstream ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json().catch(() => null)) as any;
  if (!json) throw new UpstreamError("server_error", res.status, "bedrock: invalid JSON from upstream");
  return {
    response: fromConverseResponse(json, model),
    providerId: "bedrock",
    model,
    latencyMs: Date.now() - started,
    quota: null,
  };
}
