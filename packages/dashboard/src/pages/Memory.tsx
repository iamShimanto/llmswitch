import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api } from "../api";

interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export default function Memory() {
  const { t } = useLang();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [error, setError] = useState("");
  const [cleared, setCleared] = useState("");
  const [threshold, setThreshold] = useState("0.85");

  const load = () => {
    api.cacheStats().then(setStats).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const clear = async () => {
    setError("");
    setCleared("");
    try {
      await api.clearCache();
      setCleared("Cache cleared ✓");
      load();
      setTimeout(() => setCleared(""), 3000);
    } catch (e) {
      setError(String(e));
    }
  };

  const card = "rounded-xl border border-zinc-800 bg-zinc-900 p-4";

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t("nav.memory")}</h1>
        <button
          onClick={load}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >{t("common.refresh")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {cleared && <p className="mb-4 text-emerald-400">{cleared}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div className={card}>
          <h2 className="mb-3 font-semibold">Prompt cache (exact match)</h2>
          {stats ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-zinc-500">{t("common.entries")}</p><p className="text-xl font-bold">{stats.entries}</p></div>
                <div><p className="text-zinc-500">{t("common.hitRate")}</p><p className="text-xl font-bold">{(stats.hitRate * 100).toFixed(1)}%</p></div>
                <div><p className="text-zinc-500">{t("common.hits")}</p><p className="text-lg">{stats.hits}</p></div>
                <div><p className="text-zinc-500">{t("common.misses")}</p><p className="text-lg">{stats.misses}</p></div>
              </div>
              <button
                onClick={clear}
                className="mt-4 rounded-lg border border-red-800 px-4 py-1.5 text-sm text-red-300 hover:bg-red-950"
              >{t("common.clearCache")}</button>
            </>
          ) : (
            !error && <p className="text-sm text-zinc-500">{t("common.loading")}</p>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            SHA-256 of normalized prompt, 1h TTL, max 1000 entries. Served before routing.
          </p>
        </div>

        <div className={card}>
          <h2 className="mb-3 font-semibold">Semantic cache (similarity)</h2>
          <div className="rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-sm text-amber-200">{t("memory.no_semantic_cache_api_is_exposed_yet_thi")}<code className="rounded bg-zinc-800 px-1">SEMANTIC_CACHE=1</code>{t("memory.on_the_gateway")}</div>
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-zinc-400">
              Similarity threshold (applies when the API lands): {threshold}
            </span>
            <input
              type="range"
              min="0.5"
              max="0.99"
              step="0.01"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              className="w-full"
            />
          </label>
          <p className="mt-2 text-xs text-zinc-500">
            TF-IDF today; provider-backed embeddings behind{" "}
            <code className="rounded bg-zinc-800 px-1">SEMANTIC_EMBEDDINGS=1</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
