import { randomBytes } from "node:crypto";
import type { ExecuteResult } from "../executor/http.js";
import type { ChatCompletionRequest, ChatMessage } from "../providers/types.ts";
import type { RouteOptions } from "../router/index.js";

/** In-memory ring buffer of recent requests for the inspector (P1). */

export interface InspectEntry {
  id: string;
  ts: number;
  keyId: string | null;
  provider: string;
  model: string;
  strategy: string;
  status: "ok" | "error";
  latencyMs: number;
  cached: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /** truncated request messages */
  request: Array<{ role: string; content: string }>;
  /** first 500 chars of the assistant reply */
  responsePreview: string;
  /** full original request body (enables replay); absent for old entries */
  fullBody?: ChatCompletionRequest;
}

const MAX_CONTENT = 500;

export function truncateMessages(
  messages: ChatMessage[],
  redact?: (text: string) => string,
): Array<{ role: string; content: string }> {
  return messages.slice(-6).map((m) => {
    const content = (m.content ?? "").slice(0, MAX_CONTENT);
    return { role: m.role, content: redact ? redact(content) : content };
  });
}

export class Inspector {
  private entries: InspectEntry[] = [];

  constructor(private cap = 200) {}

  record(e: Omit<InspectEntry, "id" | "ts">): InspectEntry {
    const entry: InspectEntry = {
      ...e,
      id: randomBytes(6).toString("hex"),
      ts: Date.now(),
    };
    this.entries.unshift(entry);
    if (this.entries.length > this.cap) this.entries.length = this.cap;
    return entry;
  }

  list(limit = 50): InspectEntry[] {
    return this.entries.slice(0, limit);
  }

  get(id: string): InspectEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  clear(): void {
    this.entries = [];
  }
}

export interface ReplayDiff {
  /** true when the new reply text is byte-identical to the original preview */
  same: boolean;
  origChars: number;
  newChars: number;
  origPreview: string;
  newPreview: string;
}

export interface ReplayResult {
  entryId: string;
  providerId: string;
  model: string;
  latencyMs: number;
  cached: boolean;
  text: string;
  diff: ReplayDiff;
}

/**
 * Re-execute a captured request through the router (bypassing caches) and
 * summarize how the new response differs from the original.
 * `routeFn` is the router's route() — injected for testability.
 */
export async function replayEntry(
  entry: InspectEntry,
  routeFn: (body: ChatCompletionRequest, opts?: RouteOptions) => Promise<ExecuteResult>,
): Promise<ReplayResult> {
  if (!entry.fullBody) throw new Error("replay unavailable: full request body not captured");
  const result = await routeFn(entry.fullBody, { bypassCache: true });
  let text = "";
  if (result.response) {
    text = result.response.choices[0]?.message.content ?? "";
  } else if (result.stream) {
    for await (const chunk of result.stream) {
      const c = (chunk as any)?.choices?.[0];
      if (typeof c?.delta?.content === "string") text += c.delta.content;
    }
  }
  const orig = entry.responsePreview;
  return {
    entryId: entry.id,
    providerId: result.providerId,
    model: result.model,
    latencyMs: result.latencyMs,
    cached: result.cached === true,
    text,
    diff: {
      same: text === orig,
      origChars: orig.length,
      newChars: text.length,
      origPreview: orig.slice(0, 200),
      newPreview: text.slice(0, 200),
    },
  };
}
