import { createHash } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.ts";

/**
 * Optional durable backing for the prompt cache (SQLite on the server).
 * The cache stays a fast in-memory LRU; the persister is write-through so
 * entries (not stats) survive restarts and deploys.
 */
export interface CachePersister {
  load(): Array<{ key: string; response: ChatCompletionResponse; expiresAt: number }>;
  put(key: string, response: ChatCompletionResponse, expiresAt: number): void;
  del(key: string): void;
  clear(): void;
}

interface Entry {
  response: ChatCompletionResponse;
  expiresAt: number;
}

/** JSON.stringify with recursively sorted object keys (stable key material). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Exact-match prompt cache v2.
 *
 * Strengths over v1:
 * - FULL-parameter key: every generation parameter that can change the
 *   output (top_p, stop, seed, penalties, response_format, tool_choice,
 *   user…) is part of the key — v1 missed several and could serve a
 *   response generated with different parameters.
 * - Per-caller namespace (gateway API key id): one key's cached responses
 *   are never served to another key.
 * - True LRU eviction (reads refresh recency; v1 was FIFO).
 * - Responses are cloned on the way in and out, so a caller mutating a
 *   result can never corrupt the cached copy.
 * - Optional SQLite persistence (write-through) — survives restarts.
 * - Streaming responses are cached too (assembled by the router, replayed
 *   as chunks on a hit — see cache/stream.ts).
 *
 * Bypass per request with the `x-llmswitch-cache: off` header.
 */
export class PromptCache {
  private map = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private ttlMs = 3600_000,
    private maxEntries = 2000,
    private persister?: CachePersister,
  ) {
    if (persister) {
      const now = Date.now();
      for (const row of persister.load()) {
        if (row.expiresAt > now) this.map.set(row.key, { response: row.response, expiresAt: row.expiresAt });
      }
      // LRU order after hydration: oldest-loaded are the eviction front —
      // acceptable; access patterns re-order quickly.
      while (this.map.size > this.maxEntries) {
        const first = this.map.keys().next();
        if (first.done) break;
        this.map.delete(first.value);
      }
    }
  }

  key(providerId: string, model: string, body: ChatCompletionRequest, namespace = ""): string {
    const canonical = stableStringify({
      ns: namespace,
      provider: providerId,
      model,
      messages: body.messages,
      temperature: body.temperature ?? null,
      top_p: body.top_p ?? null,
      max_tokens: body.max_tokens ?? null,
      stop: body.stop ?? null,
      seed: body.seed ?? null,
      frequency_penalty: body.frequency_penalty ?? null,
      presence_penalty: body.presence_penalty ?? null,
      response_format: body.response_format ?? null,
      tool_choice: body.tool_choice ?? null,
      tools: body.tools ?? null,
      user: body.user ?? null,
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  get(key: string, now = Date.now()): ChatCompletionResponse | null {
    const e = this.map.get(key);
    if (!e) {
      this.misses++;
      return null;
    }
    if (e.expiresAt <= now) {
      this.map.delete(key);
      this.persister?.del(key);
      this.misses++;
      return null;
    }
    // LRU: refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return structuredClone(e.response);
  }

  set(key: string, response: ChatCompletionResponse, now = Date.now()): void {
    const expiresAt = now + this.ttlMs;
    const copy = structuredClone(response);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { response: copy, expiresAt });
    this.persister?.put(key, copy, expiresAt);
    while (this.map.size > this.maxEntries) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
      this.persister?.del(first.value);
    }
  }

  stats(): {
    entries: number;
    hits: number;
    misses: number;
    hitRate: number;
    persistent: boolean;
    ttlMs: number;
    maxEntries: number;
  } {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10,
      persistent: this.persister != null,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries,
    };
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
    this.persister?.clear();
  }
}
