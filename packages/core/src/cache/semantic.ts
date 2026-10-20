import { createHash } from "node:crypto";
import type { ChatCompletionResponse } from "../providers/types.ts";

/**
 * Semantic prompt cache. Matches paraphrased prompts by meaning, not bytes.
 * Default embedder is a local TF-IDF vectorizer (zero deps, offline);
 * plug any embedding API via the Embedder interface.
 */

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Local TF-IDF embedder — no network, no API key. */
export class TfIdfEmbedder implements Embedder {
  async embed(texts: string[]): Promise<number[][]> {
    const docs = texts.map(tokenize);
    const df = new Map<string, number>();
    for (const d of docs) {
      for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const vocab = [...df.keys()];
    const n = docs.length;
    return docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      return vocab.map((t) => {
        const termFreq = (tf.get(t) ?? 0) / Math.max(1, d.length);
        const idf = Math.log(1 + n / (df.get(t) ?? 1));
        return termFreq * idf;
      });
    });
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Provider-backed embedder: delegates to any embeddings API (e.g. the
 * gateway's own /v1/embeddings). Falls back to the local TF-IDF embedder
 * when the provider call fails, so a dead embedding provider never breaks
 * chat — it just degrades match quality.
 */
export class ProviderEmbedder implements Embedder {
  private fallback = new TfIdfEmbedder();

  constructor(private embedFn: (texts: string[]) => Promise<number[][]>) {}

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const vectors = await this.embedFn(texts);
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error("embedder returned wrong shape");
      }
      return vectors;
    } catch (err) {
      console.warn(`[semantic-cache] provider embeddings failed, using TF-IDF fallback: ${(err as Error).message}`);
      return this.fallback.embed(texts);
    }
  }
}

interface Entry {
  prompt: string;
  response: ChatCompletionResponse;
  /** isolation scope: caller namespace + provider + model + system hash */
  scope: string;
  expiresAt: number;
}

/**
 * Semantic cache v2. v1 matched paraphrases across ANY provider, model,
 * system prompt and caller — a response written by one model for one user
 * could be served to another. v2 scopes every entry to
 * (namespace | provider | model | system-prompt hash) and expires
 * entries on the same TTL as the exact cache.
 */
export class SemanticCache {
  private entries: Entry[] = [];
  private hits = 0;
  private misses = 0;

  constructor(
    private embedder: Embedder = new TfIdfEmbedder(),
    private threshold = 0.92,
    private maxEntries = 500,
    private ttlMs = 3600_000,
  ) {}

  /** Canonical prompt text for similarity (last user message). */
  static promptText(messages: Array<{ role: string; content: string | null }>): string {
    const users = messages.filter((m) => m.role === "user");
    return (users[users.length - 1]?.content ?? "").slice(0, 2000);
  }

  /** Scope string for a request: responses are only shared inside it. */
  static scopeFor(
    namespace: string,
    providerId: string,
    model: string,
    messages: Array<{ role: string; content: string | null }>,
  ): string {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content ?? "")
      .join("\n");
    const sysHash = createHash("sha256").update(system).digest("hex").slice(0, 12);
    return `${namespace}|${providerId}|${model}|${sysHash}`;
  }

  async add(scope: string, prompt: string, response: ChatCompletionResponse, now = Date.now()): Promise<void> {
    // replace the existing entry for the same prompt inside the same scope
    this.entries = this.entries.filter((e) => !(e.scope === scope && e.prompt === prompt));
    this.entries.unshift({
      prompt,
      response: structuredClone(response),
      scope,
      expiresAt: now + this.ttlMs,
    });
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
  }

  /** Best in-scope match above threshold, or null. */
  async find(
    scope: string,
    prompt: string,
    now = Date.now(),
  ): Promise<{ response: ChatCompletionResponse; score: number } | null> {
    this.entries = this.entries.filter((e) => e.expiresAt > now);
    const scoped = this.entries.filter((e) => e.scope === scope);
    if (scoped.length === 0) {
      this.misses++;
      return null;
    }
    // embed query together with the in-scope corpus so TF-IDF shares one
    // vocabulary; scoping also bounds this to the caller's own slice
    const vectors = await this.embedder.embed([prompt, ...scoped.map((e) => e.prompt)]);
    const qv = vectors[0]!;
    let best: { response: ChatCompletionResponse; score: number } | null = null;
    for (let i = 0; i < scoped.length; i++) {
      const score = cosine(qv, vectors[i + 1]!);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { response: scoped[i]!.response, score };
      }
    }
    if (best) {
      this.hits++;
      return { response: structuredClone(best.response), score: best.score };
    }
    this.misses++;
    return null;
  }

  size(): number {
    return this.entries.length;
  }

  stats(): { entries: number; hits: number; misses: number; hitRate: number; threshold: number } {
    const total = this.hits + this.misses;
    return {
      entries: this.entries.length,
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10,
      threshold: this.threshold,
    };
  }

  clear(): void {
    this.entries = [];
    this.hits = 0;
    this.misses = 0;
  }
}
