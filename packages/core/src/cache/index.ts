import { createHash } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../providers/types.ts";

interface Entry {
  response: ChatCompletionResponse;
  expiresAt: number;
}

/**
 * Exact-match prompt cache (in-memory). P2 adds persistence + semantic cache.
 * Only used for non-streaming requests; bypass with x-llmswitch-cache: off.
 */
export class PromptCache {
  private map = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private ttlMs = 3600_000,
    private maxEntries = 1000,
  ) {}

  key(providerId: string, model: string, body: ChatCompletionRequest): string {
    const canonical = JSON.stringify({
      provider: providerId,
      model,
      messages: body.messages,
      temperature: body.temperature ?? null,
      max_tokens: body.max_tokens ?? null,
      tools: body.tools ?? null,
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
      this.misses++;
      return null;
    }
    this.hits++;
    return e.response;
  }

  set(key: string, response: ChatCompletionResponse, now = Date.now()): void {
    if (this.map.size >= this.maxEntries) {
      // evict oldest (Map preserves insertion order)
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(key, { response, expiresAt: now + this.ttlMs });
  }

  stats(): { entries: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      entries: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10,
    };
  }

  clear(): void {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
