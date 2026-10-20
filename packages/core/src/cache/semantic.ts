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
}

export class SemanticCache {
  private entries: Entry[] = [];

  constructor(
    private embedder: Embedder = new TfIdfEmbedder(),
    private threshold = 0.92,
    private maxEntries = 500,
  ) {}

  /** Canonical prompt text for similarity (last user message). */
  static promptText(messages: Array<{ role: string; content: string | null }>): string {
    const users = messages.filter((m) => m.role === "user");
    return (users[users.length - 1]?.content ?? "").slice(0, 2000);
  }

  async add(prompt: string, response: ChatCompletionResponse): Promise<void> {
    // replace existing entry for near-identical prompts
    this.entries = this.entries.filter((e) => e.prompt !== prompt);
    this.entries.unshift({ prompt, response });
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
  }

  /** Best match above threshold, or null. Single embed call (corpus-consistent). */
  async find(prompt: string): Promise<{ response: ChatCompletionResponse; score: number } | null> {
    if (this.entries.length === 0) return null;
    // embed query together with the corpus so TF-IDF shares one vocabulary
    const vectors = await this.embedder.embed([prompt, ...this.entries.map((e) => e.prompt)]);
    const qv = vectors[0]!;
    let best: { response: ChatCompletionResponse; score: number } | null = null;
    for (let i = 0; i < this.entries.length; i++) {
      const score = cosine(qv, vectors[i + 1]!);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { response: this.entries[i]!.response, score };
      }
    }
    return best;
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}
