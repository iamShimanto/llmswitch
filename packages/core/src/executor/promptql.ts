/**
 * PromptQL executor — chat via the PromptQL playground GraphQL agent API.
 *
 * Ported (SIMPLIFIED/thin) from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53) —
 * `open-sse/config/providers/registry/promptql/index.ts`,
 * `open-sse/executors/promptql.ts` and `open-sse/services/promptql/jwt.ts`.
 * Attribution retained.
 *
 * Protocol (reverse-engineered from the prompt.ql.app SPA):
 *   1. POST GraphQL start_thread mutation with the message + llmConfigId
 *      (the model seed maps client-facing ids to Hasura llm_config UUIDs).
 *   2. Poll the QueryThreadEvents query until an event whose serialized
 *      data contains "final_response_sent" appears (bounded timeout).
 *   3. Extract the final reply: first the `final_response.message` leaf,
 *      falling back to <final_response>…</final_response> XML.
 *
 * Auth: the user pastes the Authorization Bearer <redacted> prompt.ql.app
 * DevTools (iss=enrich-token JWT) as PROMPTQL_API_KEY. The Hasura project id
 * is read from the JWT claims (`https://promptql.hasura.io` →
 * x-hasura-project-id, else project_id/projectId, else the DDN aud).
 *
 * What this thin port DROPS vs OmniRoute: sticky thread bindings for
 * multi-turn (every request starts a fresh thread with the flattened
 * conversation as the message), send_thread_message follow-ups, credit
 * summary, the token-refresh endpoint, and streaming (a stream request
 * polls first, then emits one final chunk).
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ResolvedProvider,
} from "../providers/types.js";
import { UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

export const PROMPTQL_GRAPHQL_URL = "https://data.prompt.ql.app/promptql/playground-v2-hge/v1/graphql";
export const PROMPTQL_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
export const PROMPTQL_POLL_INTERVAL_MS = 1200;

/** Typed auth/config error the router surfaces as non-retryable. */
export class PromptQlAuthError extends UpstreamError {
  constructor(message: string) {
    super("auth_error", 401, message);
    this.name = "PromptQlAuthError";
  }
}

export function hasPromptQlCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(((env.PROMPTQL_API_KEY ?? env.PROMPTQL_TOKEN) ?? "").trim());
}

/** The session JWT: catalog env slot, with PROMPTQL_TOKEN as an alias. */
export function promptQlEnvToken(env: NodeJS.ProcessEnv): string {
  return ((env.PROMPTQL_API_KEY ?? env.PROMPTQL_TOKEN) ?? "").trim();
}

/* ------------------------------------------------------------------ *
 * Model seed (llm_config UUIDs from OmniRoute's live capture)
 * ------------------------------------------------------------------ */

export interface PromptQlSeedModel {
  id: string;
  name: string;
  configId: string;
  modelId: string;
}

export const PROMPTQL_SEED_MODELS: PromptQlSeedModel[] = [
  { id: "bedrock-claude-fable-5", name: "Claude Fable 5", configId: "c47a1e57-2fca-4cfe-913a-5fb821079f50", modelId: "us.anthropic.claude-fable-5" },
  { id: "bedrock-claude-opus-5", name: "Claude Opus 5", configId: "8aed42aa-f7c8-48f9-8238-5046bbc0f4f7", modelId: "us.anthropic.claude-opus-5" },
  { id: "bedrock-claude-sonnet-4-5", name: "Claude Sonnet 4.5", configId: "0abcbc61-dbef-4958-96b9-e0cde7e3ad8f", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" },
  { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro 0813", configId: "255de820-3615-4921-a5fe-85b4af9e37a4", modelId: "accounts/fireworks/models/deepseek-v4-pro-0813" },
  { id: "deepseek-v4-flash-0731", name: "DeepSeek V4 Flash 0731", configId: "22d8bd9a-3c48-4e27-a4f8-dc67ad2242b7", modelId: "accounts/fireworks/models/deepseek-v4-flash-0731" },
  { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", configId: "17703a97-41a4-469d-b5d4-7356f1c28948", modelId: "google/gemini-3.1-pro-preview" },
  { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash", configId: "60754535-a5e8-4ae7-acf2-43d046771700", modelId: "google/gemini-3.7-flash" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", configId: "4914e63d-ea29-45dc-9a85-c367b1ad0be5", modelId: "gpt-5.6-sol" },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", configId: "4e627eb9-a199-4a90-8050-b734b6ee5fda", modelId: "gpt-5.6-terra" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", configId: "5eac2efb-7951-4da6-9a32-bfb31b1a7788", modelId: "gpt-5.6-luna" },
  { id: "xai-grok-4-6", name: "Grok 4.6", configId: "673e97ba-7b15-4213-8984-9b2477ee3409", modelId: "grok-4.6" },
  { id: "kimi-k3", name: "Kimi K3", configId: "2a751e62-e281-4ab0-9be0-b05a6f8603db", modelId: "accounts/fireworks/models/kimi-k3" },
  { id: "glm-5.2", name: "GLM 5.2", configId: "d2694d4d-4285-4d3c-ada5-aea5956375d4", modelId: "accounts/fireworks/models/glm-5p2" },
  { id: "minimax-m3", name: "Minimax M3", configId: "c4028069-0eb9-4a31-825c-a1cff9e5a085", modelId: "accounts/fireworks/models/minimax-m3" },
];

export function resolvePromptQlModel(modelId: string): PromptQlSeedModel {
  return (
    PROMPTQL_SEED_MODELS.find((m) => m.id === modelId) ??
    PROMPTQL_SEED_MODELS.find((m) => m.modelId === modelId) ??
    PROMPTQL_SEED_MODELS[0]!
  );
}

/* ------------------------------------------------------------------ *
 * JWT helpers (from OmniRoute services/promptql/jwt.ts)
 * ------------------------------------------------------------------ */

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readStr(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/** Project id from the JWT claims (ported from OmniRoute). */
export function extractPromptQlProjectId(token: string): string {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    throw new PromptQlAuthError("promptql: the pasted token is not a JWT — paste the Authorization Bearer <redacted> prompt.ql.app (Network → graphql → Authorization)");
  }
  const hasura = payload["https://promptql.hasura.io"];
  if (hasura && typeof hasura === "object" && !Array.isArray(hasura)) {
    const id = readStr((hasura as Record<string, unknown>)["x-hasura-project-id"]);
    if (id) return id;
  }
  const direct = readStr(payload.project_id) || readStr(payload.projectId);
  if (direct) return direct;
  const aud = payload.aud;
  const audId = typeof aud === "string" ? aud : Array.isArray(aud) ? String(aud[0] ?? "") : "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(audId)) return audId;
  throw new PromptQlAuthError(
    "promptql: could not find a project id in the JWT claims — paste the playground enrich-token JWT (iss=enrich-token), not a DDN/project token",
  );
}

export function promptQlTokenExpired(token: string, skewSec = 30): boolean {
  const payload = decodeJwtPayload(token);
  const exp = typeof payload?.exp === "number" ? payload.exp : 0;
  return exp > 0 && Math.floor(Date.now() / 1000) >= exp - skewSec;
}

/* ------------------------------------------------------------------ *
 * GraphQL
 * ------------------------------------------------------------------ */

const START_THREAD_WITH_MODEL = `
mutation StartThreadWithModel(
  $message: String!
  $projectId: String!
  $timezone: String!
  $llmConfigId: String!
) {
  start_thread(
    message: $message
    projectId: $projectId
    timezone: $timezone
    llmConfigId: $llmConfigId
    roomless: true
  ) {
    thread_id
    thread_events { thread_event_id created_at event_data }
  }
}`;

const QUERY_THREAD_EVENTS = `
query QueryThreadEvents($thread_id: uuid!, $after_event_id: bigint!) {
  thread_events(
    where: {
      thread_id: {_eq: $thread_id}
      thread_event_id: {_gt: $after_event_id}
    }
    order_by: {thread_event_id: asc}
  ) {
    thread_event_id
    event_data
  }
}`;

export interface PromptQlEvent {
  thread_event_id: string | number;
  event_data?: unknown;
}

async function gql(
  token: string,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<any> {
  const res = await fetchFn(PROMPTQL_GRAPHQL_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      origin: "https://prompt.ql.app",
      referer: "https://prompt.ql.app/",
      "user-agent": PROMPTQL_USER_AGENT,
    },
    body: JSON.stringify({ query, variables, operationName }),
    signal: signal ?? undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: any; errors?: Array<{ message?: string }> } | null;
  if (!json) throw new UpstreamError("server_error", res.status, "promptql: non-JSON GraphQL response");
  if (!res.ok) throw new UpstreamError("server_error", res.status, `promptql: GraphQL HTTP ${res.status}`);
  if (json.errors?.length) {
    throw new UpstreamError("server_error", res.status, `promptql: ${json.errors.map((e) => e.message || "error").join("; ").slice(0, 300)}`);
  }
  return json.data;
}

function eventId(e: PromptQlEvent): number {
  return Number(e.thread_event_id) || 0;
}

function isFinalAgentEvent(eventData: unknown): boolean {
  return JSON.stringify(eventData ?? "").includes("final_response_sent");
}

/** Walk an object tree for leaf paths ending in final_response.message. */
function walkLeaves(value: unknown, path: string, out: Array<{ path: string; text: string }>): void {
  if (typeof value === "string") {
    if (value.trim()) out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkLeaves(v, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walkLeaves(v, path ? `${path}.${k}` : k, out);
    }
  }
}

/** Final-reply text extraction (ported from OmniRoute eventTree.ts). */
export function extractFinalResponseMessage(eventData: unknown): string | null {
  const leaves: Array<{ path: string; text: string }> = [];
  walkLeaves(eventData, "", leaves);
  const hit = leaves.find((l) => /final_response\.message$/i.test(l.path));
  if (hit) {
    const m = /<final_response>([\s\S]*?)<\/final_response>/i.exec(hit.text);
    return (m ? m[1] : hit.text).trim() || null;
  }
  // Older builds embed the XML inline inside response_text.
  for (const leaf of leaves) {
    const m = /<final_response>([\s\S]*?)<\/final_response>/i.exec(leaf.text);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  return null;
}

function flattenMessages(messages: ChatCompletionRequest["messages"]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (!text) continue;
    parts.push(m.role === "system" ? `System instructions: ${text}` : `${m.role}: ${text}`);
  }
  return parts.join("\n\n");
}

/** Run the full thread lifecycle and return the final text (bounded). */
export async function runPromptQlThread(
  token: string,
  projectId: string,
  message: string,
  modelConfigId: string,
  fetchFn: typeof fetch,
  opts: { pollMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const pollMs = opts.pollMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? PROMPTQL_POLL_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const data = await gql(
    token,
    "StartThreadWithModel",
    START_THREAD_WITH_MODEL,
    {
      message,
      projectId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
      llmConfigId: modelConfigId,
    },
    fetchFn,
  );
  const startThread = data?.start_thread;
  const threadId: string | undefined = startThread?.thread_id;
  if (!threadId) throw new UpstreamError("server_error", 0, "promptql: start_thread returned no thread_id");

  let events: PromptQlEvent[] = startThread?.thread_events ?? [];
  const deadline = Date.now() + pollMs;
  for (;;) {
    const final = events.find((e) => isFinalAgentEvent(e.event_data));
    if (final) {
      const text = extractFinalResponseMessage(final.event_data);
      if (text) return text;
      throw new UpstreamError("server_error", 0, "promptql: final event arrived but no response text was extracted");
    }
    if (Date.now() >= deadline) {
      throw new UpstreamError("timeout", 0, "promptql: agent did not finish within the poll budget");
    }
    await sleep(intervalMs);
    const latest = events.reduce((mx, e) => Math.max(mx, eventId(e)), 0);
    const next = await gql(
      token,
      "QueryThreadEvents",
      QUERY_THREAD_EVENTS,
      { thread_id: threadId, after_event_id: latest },
      fetchFn,
    );
    events = [...events, ...((next?.thread_events ?? []) as PromptQlEvent[])];
  }
}

/**
 * Gateway path: resolve token → start thread → poll → map to OpenAI shape.
 * Used by the router when provider.id === "promptql".
 */
export async function executePromptQlChat(
  provider: ResolvedProvider,
  model: string,
  body: ChatCompletionRequest,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 180_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExecuteResult> {
  const token = (provider.apiKey && provider.apiKey !== "oauth" ? provider.apiKey : "").trim() ||
    promptQlEnvToken(env);
  if (!token) {
    throw new PromptQlAuthError(
      "promptql: no token — paste the Authorization Bearer <redacted> prompt.ql.app DevTools (Network → graphql on data.prompt.ql.app) into PROMPTQL_API_KEY",
    );
  }
  if (promptQlTokenExpired(token)) {
    throw new PromptQlAuthError("promptql: the JWT is expired — paste a fresh token from prompt.ql.app into PROMPTQL_API_KEY");
  }
  const projectId = extractPromptQlProjectId(token);
  const started = Date.now();
  const message = flattenMessages(body.messages);
  const text = await runPromptQlThread(token, projectId, message, resolvePromptQlModel(model).configId, fetchFn, {
    pollMs: Math.min(timeoutMs, 180_000),
  });
  const latencyMs = Date.now() - started;

  const finish = (t: string): ChatCompletionResponse => ({
    id: `chatcmpl-${Date.now()}`,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: t }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });

  if (body.stream === true) {
    // The agent API is request/response only; emit one final chunk.
    const gen = (async function* () {
      yield {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion.chunk",
        model,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      };
    })();
    return { stream: gen, providerId: "promptql", model, latencyMs, quota: null };
  }
  return { response: finish(text), providerId: "promptql", model, latencyMs, quota: null };
}
