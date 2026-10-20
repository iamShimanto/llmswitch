import { loadConfig } from "./config.js";
import { detectLocalProviders } from "./providers/local.js";
import { registry } from "./providers/registry.js";
import { createServer, listenWithFallback } from "./server.js";
import { attachWs } from "./ws/index.js";
import { Store } from "./store/db.js";

// Re-exports for the CLI and embedders
export { loadConfig } from "./config.js";
export { registry } from "./providers/registry.js";
export { createRouter } from "./router/index.js";
export { detectLocalProviders } from "./providers/local.js";
export { compressText, isCompressionMode } from "./compression/index.js";
export { Store } from "./store/db.js";
export { startMcp } from "./mcp/server.js";

function log(level: string, ...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}] [${level}]`, ...args);
}

/** First-run: ensure at least one API key exists and show it once. */
function ensureFirstRunKey(store: Store): void {
  const keys = store.listApiKeys();
  if (keys.length > 0) return;
  const { key } = store.createApiKey("default");
  console.log("");
  console.log("  🔑 First run — your gateway API key (shown once):");
  console.log("");
  console.log(`     ${key}`);
  console.log("");
  console.log("  Use it as:  Authorization: Bearer <key>");
  console.log("  Manage keys any time in the dashboard.");
  console.log("");
}

export async function start(): Promise<void> {
  const config = loadConfig();

  // best-effort: pick up local Ollama / LM Studio servers
  try {
    for (const def of await detectLocalProviders()) {
      registry.register(def);
    }
  } catch {
    /* local detection never blocks boot */
  }

  const providers = registry.connected();

  const store = new Store(config.dataDir);
  ensureFirstRunKey(store);

  const { app, router, store: serverStore } = createServer(config, providers, store, registry);
  const { port, host, server } = await listenWithFallback(app, config.port);

  // realtime websocket: GET /v1/ws (same gateway-key auth as /v1/*)
  attachWs(server, { router, store: serverStore });

  log("info", `LLMSwitch v0.1.0 listening on http://${host}:${port}`);
  log("info", `API: http://${host}:${port}/v1   Dashboard: http://${host}:${port}/`);
  if (providers.length === 0) {
    log("warn", "No providers connected — set e.g. GROQ_API_KEY and restart.");
  } else {
    log("info", `Connected providers: ${providers.map((p) => p.id).join(", ")}`);
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "shutting down…");
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // force-exit if connections hang
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run when executed directly (not when imported by tests/CLI wrapper).
// Works both as compiled dist/index.js and via tsx src/index.ts.
const isMain = /[\\/]index\.(js|ts)$/.test(process.argv[1] ?? "");
if (isMain) {
  start().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
