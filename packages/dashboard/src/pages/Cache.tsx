import { useEffect, useState } from "react";
import { useLang } from "../i18n";
import { api } from "../api";
import { Tabs, TabEmpty } from "../components/Tabs";

interface CacheStats {
  exact: {
    entries: number;
    hits: number;
    misses: number;
    hitRate: number;
    persistent: boolean;
    ttlMs: number;
    maxEntries: number;
  };
  semantic: { entries: number; hits: number; misses: number; hitRate: number; threshold: number } | null;
}

function PromptCache() {
  const { t } = useLang();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [error, setError] = useState("");
  const [cleared, setCleared] = useState(false);

  const load = () => {
    api.cacheStats().then(setStats).catch((e) => setError(String(e)));
  };
  useEffect(load, []);

  const clear = async () => {
    if (!confirm(t("common.confirmClearCache"))) return;
    try {
      await api.clearCache();
      setCleared(true);
      setTimeout(() => setCleared(false), 2000);
      load();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div>
      <div className="mb-6 flex items-center justify-end">
        <button
          onClick={clear}
          className="rounded-lg border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
        >{t("common.clearCache")}</button>
      </div>
      {error && <p className="mb-4 text-red-400">{error}</p>}
      {cleared && <p className="mb-4 text-emerald-400">{t("common.cacheCleared")}</p>}

      <div className="grid gap-4 md:grid-cols-4">
        {[
          { label: "Entries", value: stats?.exact.entries ?? "—" },
          { label: "Hits", value: stats?.exact.hits ?? "—" },
          { label: "Misses", value: stats?.exact.misses ?? "—" },
          { label: "Hit rate", value: stats ? `${stats.exact.hitRate.toFixed(1)}%` : "—" },
        ].map((c) => (
          <div key={c.label} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
            <p className="text-xs text-zinc-500">{c.label}</p>
            <p className="mt-1 text-2xl font-bold">{c.value}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs leading-relaxed text-zinc-500">
        Exact-match prompt cache v2: full-parameter keys (temperature, top_p, stop, seed,
        tools…), isolated per gateway API key, true LRU eviction, and streaming responses are
        cached too. Entries expire after{" "}
        {stats ? `${Math.round(stats.exact.ttlMs / 60000)} min` : "60 min"} (max{" "}
        {stats?.exact.maxEntries.toLocaleString() ?? "2,000"} entries) and are{" "}
        {stats?.exact.persistent ? (
          <span className="text-emerald-400">persisted in SQLite — they survive restarts and deploys</span>
        ) : (
          "kept in memory only"
        )}
        .
      </p>
      {stats?.semantic && (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h3 className="mb-1 font-semibold">Semantic cache (active)</h3>
          <p className="text-sm text-zinc-400">
            {stats.semantic.entries} entries · {stats.semantic.hits} hits · {stats.semantic.misses}{" "}
            misses · {stats.semantic.hitRate.toFixed(1)}% hit rate · threshold{" "}
            {stats.semantic.threshold}. Matches are scoped per API key + provider + model +
            system prompt.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Cache() {
  const { t } = useLang();
  const [tab, setTab] = useState("prompt");
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">{t("nav.cache")}</h1>
      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: "prompt", label: "Prompt Cache" },
          { id: "media", label: "Media Cache" },
          { id: "semantic", label: "Semantic" },
        ]}
      />
      {tab === "prompt" && <PromptCache />}
      {tab === "media" && (
        <TabEmpty>
          The gateway does not cache media generations yet — image/audio/video responses are always
          fetched live from the provider. Prompt caching (previous tab) covers text requests.
        </TabEmpty>
      )}
      {tab === "semantic" && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
          <h2 className="mb-2 font-semibold">{t("cache.semantic_cache")}</h2>
          <p className="text-sm text-zinc-500">
            The embedding-based semantic cache is controlled by the{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">SEMANTIC_CACHE</code> and{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs">SEMANTIC_EMBEDDINGS</code>{" "}
            environment flags on the gateway — there is no runtime toggle API yet. Restart the
            gateway with the flags set to enable it. Exact-match prompt caching (Prompt Cache tab)
            is always on.
          </p>
        </div>
      )}
    </div>
  );
}
