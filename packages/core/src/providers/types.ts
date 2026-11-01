/** Wire format a provider speaks natively. */
export type WireFormat = "openai" | "anthropic" | "gemini";

/** Static definition of a provider (data only — no secrets). */
export interface ProviderDef {
  /** stable id, e.g. "openai" */
  id: string;
  /** display name */
  name: string;
  /** default API base URL */
  baseUrl: string;
  wireFormat: WireFormat;
  /** env var holding the API key, e.g. "OPENAI_API_KEY" */
  envKey: string;
  /** env var for base-URL override, e.g. "OPENAI_BASE_URL" */
  envBaseUrl?: string;
  /** known model ids (used for /v1/models and model lookup) */
  models: string[];
  /** model used when the client asks for "auto" */
  defaultModel: string;
  /** relative cost tier 1 (cheapest) – 5; used by cost-optimized routing */
  costTier: 1 | 2 | 3 | 4 | 5;
  /** routing weight for weighted strategy */
  weight?: number;
  /** published context window in tokens (optional; used by context-optimized) */
  contextWindow?: number;
  /** provider supports prompt caching (used by cache-optimized) */
  supportsPromptCache?: boolean;
  /** no API key needed (local servers like Ollama) — connected without env key */
  noAuth?: boolean;
  /**
   * auth mechanism; defaults to "api-key".
   * - "oauth": tokens resolve from a login session at call time.
   * - "token-import": paste-only, no OAuth flow exists.
   * - "none": truly keyless public endpoint — ALWAYS connected, never
   *   requires a key, and no Authorization header is sent when no key is
   *   configured. `envKey` stays meaningful: when the user DOES set a
   *   (usually free) key it is sent, which typically just raises the
   *   anonymous rate limit (OmniRoute's "optional" auth).
   * - "env-creds": multi-part credentials live entirely in the environment
   *   (e.g. AWS SigV4 key pair, GCP service account) — `envKey` names no
   *   single secret; connected-ness is decided by the provider's own
   *   has*Creds check and the executor resolves creds at call time.
   * - "cookie": unofficial web-session provider — connected when the user
   *   has imported browser cookies (`llmswitch cookies <id>` writes
   *   ~/.llmswitch/sessions/<id>.json); the per-site driver in the
   *   web-session pack resolves cookies at call time.
   */
  authType?: "api-key" | "oauth" | "token-import" | "none" | "env-creds" | "cookie";
  /** extra static headers merged into the OpenAI-wire request (e.g. client fingerprints) */
  extraHeaders?: Record<string, string>;
  /** chat path override for OpenAI-wire providers whose completions endpoint is not "<baseUrl>/chat/completions" (e.g. command-code) */
  chatPath?: string;
  /** catalog entry that cannot be used (e.g. local-CLI-only transport); registry keeps it disconnected */
  disabled?: string;
}

/** A provider with credentials resolved from the environment. */
export interface ResolvedProvider extends Omit<ProviderDef, "envKey" | "envBaseUrl"> {
  /** request params stripped before sending (dashboard Param Filters) */
  blockedParams?: string[];
  apiKey: string;
  baseUrl: string;
  /** all configured keys for rotation (collectKeys); [apiKey] when single */
  allKeys?: string[];
  /** Multi-account refs attached at resolution (DB provider_accounts). */
  accounts?: Array<{ id: string; label: string; kind: "api_key" | "session" }>;
  /** Maps an api-key VALUE to its account id (stats attribution). */
  keyAccounts?: Map<string, string>;
}

/** OpenAI-style multimodal content parts (vision requests). */
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

/** Message content: plain text, or an ordered list of text/image parts. */
export type MessageContent = string | ContentPart[] | null;

/** A tool call carried on an assistant message (request side; fields are
 *  optional because clients vary — wire translators fill defaults). */
export interface MessageToolCall {
  id?: string;
  type?: string;
  function?: { name: string; arguments?: string };
}

/** Minimal OpenAI-style chat completion request (subset we support). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: MessageContent;
  /** Assistant tool calls — preserved end-to-end so wire translators can
   *  map them to native function-call formats instead of dropping them. */
  tool_calls?: MessageToolCall[];
  /** For role:"tool" messages: the id of the call being answered. */
  tool_call_id?: string;
  /** For role:"tool" messages: the function name (some wires require it). */
  name?: string;
}

/** Concatenated text of a message content: strings pass through unchanged;
 *  part arrays contribute their text parts (images contribute nothing). */
export function contentText(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is TextContentPart => p?.type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

/** True when the content carries at least one image part. */
export function hasImageParts(content: MessageContent | undefined): boolean {
  return Array.isArray(content) && content.some((p) => p?.type === "image_url");
}

/** Parse a `data:` URL into media type + payload (null when not a data URL). */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return null;
  return { mediaType: m[1] || "application/octet-stream", data: m[3] ?? "" };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[] | null;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  response_format?: unknown;
  user?: string;
  stream?: boolean;
  tools?: ToolDef[];
  tool_choice?: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
