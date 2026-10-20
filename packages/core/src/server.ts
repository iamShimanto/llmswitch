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
  const router = createRouter(providers, { cache, semantic });
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
    const fresh = registry.connected(env);
    providers.splice(0, providers.length, ...fresh);
  };
  registerRoutes(app, { config, providers, store, router, cache, alerter, inspector, routingLog, refreshProviders, registry });

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
