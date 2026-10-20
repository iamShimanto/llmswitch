import type { ProviderDef } from "./types.ts";

/** Best-effort detection of local model servers (Ollama, LM Studio). */

export interface LocalDetectOptions {
  ollamaUrl?: string;
  lmstudioUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function getJson(url: string, fetchFn: typeof fetch, timeoutMs: number): Promise<any> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Returns provider defs for reachable local servers (empty when none). */
export async function detectLocalProviders(opts: LocalDetectOptions = {}): Promise<ProviderDef[]> {
  const {
    ollamaUrl = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
    lmstudioUrl = process.env.LMSTUDIO_URL ?? "http://127.0.0.1:1234",
    fetchFn = fetch,
    timeoutMs = 1500,
  } = opts;
  const found: ProviderDef[] = [];

  try {
    const tags = await getJson(`${ollamaUrl}/api/tags`, fetchFn, timeoutMs);
    const models: string[] = (tags.models ?? []).map((m: any) => m.name).filter(Boolean);
    if (models.length > 0) {
      found.push({
        id: "ollama",
        name: "Ollama (local)",
        baseUrl: `${ollamaUrl}/v1`,
        wireFormat: "openai",
        envKey: "OLLAMA_API_KEY",
        models,
        defaultModel: models[0]!,
        costTier: 1,
        noAuth: true,
      });
    }
  } catch {
    /* not running — fine */
  }

  try {
    const list = await getJson(`${lmstudioUrl}/v1/models`, fetchFn, timeoutMs);
    const models: string[] = (list.data ?? []).map((m: any) => m.id).filter(Boolean);
    if (models.length > 0) {
      found.push({
        id: "lmstudio",
        name: "LM Studio (local)",
        baseUrl: `${lmstudioUrl}/v1`,
        wireFormat: "openai",
        envKey: "LMSTUDIO_API_KEY",
        models,
        defaultModel: models[0]!,
        costTier: 1,
        noAuth: true,
      });
    }
  } catch {
    /* not running — fine */
  }

  return found;
}
