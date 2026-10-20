import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Alerter } from "./alerts/index.js";
import { PromptCache } from "./cache/index.js";
import { ProviderEmbedder, SemanticCache } from "./cache/semantic.js";
import type { AppConfig } from "./config.js";
import { createAuth } from "./ingress/auth.js";
import { DashboardSessions, registerDashboardAuthRoutes } from "./ingress/dashboardAuth.js";
import { registerRoutes } from "./ingress/routes.js";
import { Inspector } from "./inspect/index.js";
import { RateLimiter } from "./quota/limiter.js";
import { createRouter, type Router } from "./router/index.js";
import type { RouterCombo } from "./combos/index.js";
import { RoutingEventLog } from "./router/events.js";
import { Store } from "./store/db.js";
import { costUsd, setPriceOverrides } from "./billing/prices.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { ResolvedProvider } from "./providers/types.js";

export interface ServerContext {
  app: Express;
  config: AppConfig;
  store: Store;
  providers: ResolvedProvider[];
  limiter: RateLimiter;
  cache: PromptCache;
  alerter: Alerter;
  inspector: Inspector;
  routingLog: RoutingEventLog;
  router: Router;
  dashboardDir: string | null;
}

export function createServer(
  config: AppConfig,
  providers: ResolvedProvider[],
  store: Store,
  registry?: ProviderRegistry,
): ServerContext {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false, limit: "10mb" }));
  // trust proxy headers when behind docker/nginx
  app.set("trust proxy", 1);
  // baseline security headers
  app.use((_req, res, next) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });

  // Pricing: apply saved user overrides, then backfill historical usage
  // rows that were logged before their model had a price (one-time).
  try {
    const rawOverrides = store.getSetting("price_overrides");
    if (rawOverrides) setPriceOverrides(JSON.parse(rawOverrides) as Record<string, { input: number; output: number }>);
    if (!store.getSetting("pricing_backfill_v2")) {
      const filled = store.backfillZeroCosts(costUsd);
      store.setSetting("pricing_backfill_v2", "1");
      if (filled > 0) console.log(`[llmswitch] pricing: backfilled cost for ${filled} historical usage rows`);
    }
  } catch {
    /* pricing warmup must never block boot */
  }

  // Automatic database backups: one at boot if the newest is >24h old
  // (or none exists), then daily; keeps the newest 7. Disable with
  // BACKUP_AUTO=0. Failures never block boot.
  if (process.env.BACKUP_AUTO !== "0") {
    const runAutoBackup = () => {
      try {
        const newest = store.listBackups()[0];
        if (!newest || Date.now() - newest.createdAt > 24 * 3600_000) {
          const b = store.createBackup();
          const pruned = store.pruneBackups(7);
          console.log(`[llmswitch] auto-backup created: ${b.name}${pruned ? ` (pruned ${pruned} old)` : ""}`);
        }
      } catch (err) {
        console.error(`[llmswitch] auto-backup failed: ${(err as Error).message}`);
      }
    };
    runAutoBackup();
    setInterval(runAutoBackup, 3600_000).unref();
  }

  // Usage-log retention: prune rows older than usage_retention_days
  // (default 180; 0 = keep forever) at boot and daily.
  const runRetention = () => {
    try {
      const days = Number(store.getSetting("usage_retention_days") ?? 180);
      if (days > 0) {
        const n = store.pruneUsageOlderThan(Date.now() - days * 24 * 3600_000);
        if (n > 0) console.log(`[llmswitch] retention pruned ${n} usage rows older than ${days}d`);
      }
    } catch (err) {
      console.error(`[llmswitch] retention failed: ${(err as Error).message}`);
    }
  };
  runRetention();
  setInterval(runRetention, 24 * 3600_000).unref();

  const limiter = new RateLimiter(600);
  // Prompt cache v2: SQLite write-through persistence (survives deploys),
  // true LRU, per-key namespaces, streaming support. Env knobs:
  // CACHE_TTL_MS (default 1h), CACHE_MAX_ENTRIES (default 2000).
  store.cachePruneExpired();
  const cache = new PromptCache(
    Number(process.env.CACHE_TTL_MS ?? 3600_000) || 3600_000,
    Number(process.env.CACHE_MAX_ENTRIES ?? 2000) || 2000,
    {
      load: () =>
        store.cacheLoadAll().flatMap((r) => {
          try {
            return [{ key: r.key, response: JSON.parse(r.response), expiresAt: r.expiresAt }];
          } catch {
            return [];
          }
        }),
      put: (key, response, expiresAt) => store.cachePut(key, JSON.stringify(response), expiresAt),
      del: (key) => store.cacheDel(key),
      clear: () => store.cacheClear(),
    },
  );
  // Provider-backed embeddings for the semantic cache (opt-in). Falls back to
  // local TF-IDF when SEMANTIC_EMBEDDINGS is unset or the provider call fails.
  const embedViaProvider =
    process.env.SEMANTIC_EMBEDDINGS === "1"
      ? async (texts: string[]): Promise<number[][]> => {
          const p = providers.find((x) => x.wireFormat === "openai" && x.apiKey);
          if (!p) throw new Error("no openai-wire provider connected for embeddings");
          const model = process.env.SEMANTIC_EMBEDDING_MODEL ?? "text-embedding-3-small";
          const res = await fetch(`${p.baseUrl}/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
            body: JSON.stringify({ model, input: texts }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) throw new Error(`embeddings upstream HTTP ${res.status}`);
          const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
          const vectors = (json.data ?? []).map((d) => d.embedding ?? []);
          if (vectors.length !== texts.length) throw new Error("embeddings upstream shape mismatch");
          return vectors;
        }
      : undefined;
  const semantic =
    process.env.SEMANTIC_CACHE === "1"
      ? new SemanticCache(
          embedViaProvider ? new ProviderEmbedder(embedViaProvider) : undefined,
          Number(process.env.SEMANTIC_CACHE_THRESHOLD ?? 0.92),
          500,
          Number(process.env.CACHE_TTL_MS ?? 3600_000) || 3600_000,
        )
      : undefined;
  const alerter = new Alerter();
  // dashboard-persisted webhook override (survives restarts)
  const savedWebhook = store.getSetting("alert_webhook_url");
  if (savedWebhook) alerter.setWebhookUrl(savedWebhook);
  const inspector = new Inspector();
  // Seed the request feed from the persisted usage log so Live/Activity
  // history survives restarts (the ring buffer itself is memory-only —
  // prompts/responses are never written to the DB, history rows show
  // metadata only).
  try {
    for (const u of store.recentUsage(50)) {
      inspector.seed([
        {
          id: `hist-${u.ts}-${Math.random().toString(36).slice(2, 8)}`,
          ts: u.ts,
          keyId: u.keyId,
          provider: u.provider,
          model: u.model,
          strategy: "history",
          status: u.status === "ok" ? "ok" : "error",
          latencyMs: u.latencyMs,
          cached: false,
          promptTokens: u.promptTokens,
          completionTokens: u.completionTokens,
          costUsd: u.costUsd,
          request: [],
          responsePreview: "",
        },
      ]);
    }
  } catch {
    /* a seeding failure must never block boot */
  }
  const router = createRouter(providers, {
    cache,
    semantic,
    accounts: {
      strategy: (providerId: string) => {
        // Per-provider override wins over the global account strategy.
        const per = store.getSetting(`account_strategy:${providerId}`);
        const v = per ?? store.getSetting("account_strategy");
        return v === "least-used" || v === "priority" || v === "random" ? v : "round-robin";
      },
      stats: (providerId) =>
        store.listAccounts(providerId).map((a) => ({ id: a.id, calls: a.calls })),
      record: (accountId, ok, error) => {
        try {
          store.recordAccountUse(accountId, ok, error);
        } catch {
          /* stats must never break traffic */
        }
      },
      capped: (() => {
        // Memoized 15s: a usage_log SUM per request would be wasteful.
        let memo = new Map<string, { at: number; ids: Set<string> }>();
        return (providerId: string): Set<string> => {
          const hit = memo.get(providerId);
          if (hit && Date.now() - hit.at < 15_000) return hit.ids;
          const ids = new Set<string>();
          try {
            const dayStart = new Date().setUTCHours(0, 0, 0, 0);
            for (const a of store.listAccounts(providerId)) {
              if (a.dailyCapUsd != null && store.accountDailySpend(a.id, dayStart) >= a.dailyCapUsd) {
                ids.add(a.id);
              }
            }
          } catch {
            /* cap checks must never break traffic */
          }
          memo.set(providerId, { at: Date.now(), ids });
          return ids;
        };
      })(),
    },
    routingRules: () => store.listRoutingRules(),
    combos: () =>
      store
        .listCombos()
        .filter((c) => (c.kind === "router" || c.targets) && c.targets)
        .map((c) => ({
          name: c.name,
          description: c.description,
          kind: "router" as const,
          strategy: (c.strategy ?? "priority") as RouterCombo["strategy"],
          targets: c.targets!,
          config: c.config,
          enabled: c.enabled,
          createdAt: c.createdAt,
        })),
    globalSystemPrompt: () => {
      if (store.getSetting("gsp_enabled") !== "1") return null;
      const text = store.getSetting("gsp_text");
      return text && text.trim() ? text : null;
    },
  });
  const routingLog = new RoutingEventLog();

  // Dashboard SPA (served when built; absent in pure-API mode)
  const dashboardDir = join(process.cwd(), "packages", "dashboard", "dist");
  const hasDashboard = existsSync(join(dashboardDir, "index.html"));

  const sessions = new DashboardSessions(store);
  // VS Code token alias: /api/v1/vscode/<gateway-key>/... behaves exactly
  // like /v1/... with that key as the Bearer token — for tools (VS Code
  // Copilot Chat BYOK etc.) that cannot set an Authorization header.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const m = /^\/api\/v1\/vscode\/([^/]+)(\/.*)?$/.exec(req.url);
    if (m) {
      try {
        req.headers.authorization = `Bearer ${decodeURIComponent(m[1])}`;
      } catch {
        req.headers.authorization = `Bearer ${m[1]}`;
      }
      req.url = `/v1${m[2] ?? ""}`;
    }
    next();
  });
  app.use(createAuth(store, limiter, sessions));
  registerDashboardAuthRoutes(app, store, sessions);
  // Re-resolve connected providers IN PLACE (same array reference the
  // router and routes hold) so OAuth connects / cookie imports / key adds
  // take effect immediately — no gateway restart needed.
  const refreshProviders = () => {
    if (!registry) return;
    // Dashboard-saved provider API keys live in the store as
    // `provider_key:<ENV_NAME>` settings; merge them over process.env so
    // keys added at runtime (or in earlier runs) connect without a restart.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(store.listSettings("provider_key:"))) {
      env[k.slice("provider_key:".length)] = v;
    }
    // Multi-account: enabled DB accounts force-resolve their provider
    // (an account may be its ONLY credential) and attach to it below.
    const enabledAccounts = store.listAccounts().filter((x) => x.enabled);
    const forceIds = new Set(enabledAccounts.map((x) => x.providerId));
    const fresh = registry.connected(env, forceIds);
    for (const p of fresh) {
      const accts = enabledAccounts.filter((x) => x.providerId === p.id);
      if (accts.length === 0) continue;
      p.accounts = accts.map((x) => ({ id: x.id, label: x.label, kind: x.kind }));
      const keyAccts = accts.filter((x) => x.kind === "api_key" && x.secret);
      if (keyAccts.length > 0) {
        p.keyAccounts = new Map();
        const keys = [...(p.allKeys ?? [])];
        for (const a of keyAccts) {
          if (!keys.includes(a.secret!)) keys.push(a.secret!);
          p.keyAccounts.set(a.secret!, a.id);
        }
        p.allKeys = keys;
        if (!p.apiKey) p.apiKey = keys[0] ?? "";
      }
    }
    // Union in models the user discovered/imported earlier — they persist
    // in the store (discovered_models:<id>) across restarts and refreshes.
    for (const p of fresh) {
      const raw = store.getSetting(`discovered_models:${p.id}`);
      if (!raw) continue;
      try {
        const extra = JSON.parse(raw) as string[];
        p.models = [...new Set([...p.models, ...extra])];
      } catch {
        /* corrupted setting: ignore */
      }
    }
    // Custom models the user added by hand (dashboard Custom Models):
    // unioned like discovered models, before hidden filtering.
    for (const p of fresh) {
      const raw = store.getSetting(`custom_models:${p.id}`);
      if (!raw) continue;
      try {
        const custom = JSON.parse(raw) as Array<{ id: string }>;
        p.models = [...new Set([...p.models, ...custom.map((c) => c.id)])];
      } catch {
        /* corrupted setting: ignore */
      }
    }
    // Hidden models (dashboard eye toggle): removed from routing; the
    // catalog re-adds them for display from the same setting.
    for (const p of fresh) {
      const raw = store.getSetting(`hidden_models:${p.id}`);
      if (!raw) continue;
      try {
        const hidden = new Set(JSON.parse(raw) as string[]);
        if (hidden.size > 0) {
          p.models = p.models.filter((m) => !hidden.has(m));
          if (hidden.has(p.defaultModel) && p.models.length > 0) {
            p.defaultModel = p.models[0]!;
          }
        }
      } catch {
        /* corrupted setting: ignore */
      }
    }
    // Param Filters (dashboard): params stripped per provider at send time.
    for (const p of fresh) {
      const raw = store.getSetting(`param_block:${p.id}`);
      if (raw) {
        p.blockedParams = raw.split(",").map((x) => x.trim()).filter(Boolean);
      }
    }
    // User-chosen default model per provider (dashboard model rows).
    for (const p of fresh) {
      const dm = store.getSetting(`default_model:${p.id}`);
      if (dm && p.models.includes(dm)) p.defaultModel = dm;
    }
    // Providers the user switched off in the dashboard leave rotation.
    const active = fresh.filter((p) => store.getSetting(`provider_off:${p.id}`) !== "1");
    providers.splice(0, providers.length, ...active);
  };
  refreshProviders();
  // Persist every recorded request to the DB-backed request log
  // (OmniRoute-style searchable history; the inspector stays the live view).
  inspector.subscribe((entry) => {
    try {
      store.logRequest(entry);
    } catch {
      /* logging must never break traffic */
    }
  });
  registerRoutes(app, { config, providers, store, router, cache, semantic, alerter, inspector, routingLog, refreshProviders, registry, dashboardSessions: sessions });

  if (hasDashboard) {
    app.use(express.static(dashboardDir));
    app.get("*", (_req, res) => res.sendFile(join(dashboardDir, "index.html")));
  }

  return { app, config, store, providers, limiter, cache, alerter, inspector, routingLog, router, dashboardDir: hasDashboard ? dashboardDir : null };
}

/** Listen with automatic fallback to the next free port. */
export function listenWithFallback(
  app: Express,
  preferredPort: number,
  host = process.env.HOST || "127.0.0.1",
): Promise<{ port: number; host: string; server: import("node:http").Server }> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number): void => {
      const server = app.listen(port, host, () => resolve({ port, host, server }));
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < preferredPort + 100) {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
    };
    tryPort(preferredPort);
  });
}
