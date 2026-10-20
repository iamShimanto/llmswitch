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
  apiKey: string;
  baseUrl: string;
  /** all configured keys for rotation (collectKeys); [apiKey] when single */
  allKeys?: string[];
  /** Multi-account refs attached at resolution (DB provider_accounts). */
  accounts?: Array<{ id: string; label: string; kind: "api_key" | "session" }>;
  /** Maps an api-key VALUE to its account id (stats attribution). */
  keyAccounts?: Map<string, string>;
}

/** Minimal OpenAI-style chat completion request (subset we support). */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
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
