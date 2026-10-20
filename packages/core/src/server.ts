import express, { type Express } from "express";
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
import { RoutingEventLog } from "./router/events.js";
import { Store } from "./store/db.js";
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
    res.setHeader("x-frame-options", "SAMEORIGIN");
    res.setHeader("referrer-policy", "no-referrer");
    next();
  });

  const limiter = new RateLimiter(600);
  const cache = new PromptCache();
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
      strategy: () => {
        const v = store.getSetting("account_strategy");
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
    },
    routingRules: () => store.listRoutingRules(),
  });
  const routingLog = new RoutingEventLog();

  // Dashboard SPA (served when built; absent in pure-API mode)
  const dashboardDir = join(process.cwd(), "packages", "dashboard", "dist");
  const hasDashboard = existsSync(join(dashboardDir, "index.html"));

  const sessions = new DashboardSessions(store);
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
    // User-chosen default model per provider (dashboard model rows).
    for (const p of fresh) {
      const dm = store.getSetting(`default_model:${p.id}`);
      if (dm && p.models.includes(dm)) p.defaultModel = dm;
    }
    providers.splice(0, providers.length, ...fresh);
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
  registerRoutes(app, { config, providers, store, router, cache, alerter, inspector, routingLog, refreshProviders, registry, dashboardSessions: sessions });

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
