#!/usr/bin/env node
/**
 * P1 API smoke test: boots the real gateway and exercises every new P1
 * endpoint + header end-to-end. Exit non-zero on any failure.
 */
import http from "node:http";
import { registry } from "../packages/core/dist/providers/registry.js";
import { loadConfig } from "../packages/core/dist/config.js";
import { createServer, listenWithFallback } from "../packages/core/dist/server.js";
import { Store } from "../packages/core/dist/store/db.js";

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}`);
  if (!cond) failures++;
}

const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-1", model: "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      }),
    );
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const mockPort = upstream.address().port;

registry.register({
  id: "mocktest", name: "MockTest",
  baseUrl: `http://127.0.0.1:${mockPort}`,
  wireFormat: "openai", envKey: "MOCKTEST_API_KEY", envBaseUrl: "MOCKTEST_BASE_URL",
  models: ["mock-model"], defaultModel: "mock-model", costTier: 1,
});
process.env.MOCKTEST_API_KEY = "x";
process.env.PORT = "6397";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-p1";

const config = loadConfig();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, registry.connected(), store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const chatBody = { model: "auto", messages: [{ role: "user", content: "hello world" }] };

async function post(path, body, headers = {}) {
  const r = await fetch(`${base}${path}`, {
    method: "POST", headers: { ...H, ...headers }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
}
async function get(path, headers = {}) {
  const r = await fetch(`${base}${path}`, { headers: { ...H, ...headers } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text, headers: r.headers };
}

try {
  // ---- compression API ----
  let r = await post("/api/compression/preview", {
    text: "Hello! Could you please explain in detail how this works? Thank you very much!",
    mode: "caveman",
  });
  check("POST /api/compression/preview → 200 + saved chars", r.status === 200 && r.json.stats.savedChars > 0);

  r = await post("/v1/chat/completions", chatBody, { "x-llmswitch-compress": "stacked" });
  check("x-llmswitch-compress header → 200", r.status === 200);

  // ---- new strategies via header ----
  for (const s of ["p2c", "fill-first", "lkgp", "headroom", "quota-weighted", "strict-random",
    "context-optimized", "cache-optimized", "fusion", "pipeline", "reset-aware", "reset-window",
    "context-relay", "least-used", "cost-optimized", "weighted", "round-robin", "random", "auto"]) {
    r = await post("/v1/chat/completions", chatBody, { "x-llmswitch-strategy": s });
    if (r.status !== 200) { check(`strategy header ${s} → 200`, false); break; }
  }
  check("all 19 strategy headers → 200", r.status === 200);

  r = await post("/v1/chat/completions", chatBody, { "x-llmswitch-session": "sess-1" });
  check("x-llmswitch-session header → 200", r.status === 200);

  // ---- cache API ----
  await fetch(`${base}/api/cache`, { method: "DELETE", headers: H });
  r = await post("/v1/chat/completions", chatBody);
  check("first request not cached", r.status === 200 && r.json.cached !== true);
  r = await post("/v1/chat/completions", chatBody);
  check("second identical request cached", r.status === 200 && r.json.cached === true);
  r = await post("/v1/chat/completions", chatBody, { "x-llmswitch-cache": "off" });
  check("x-llmswitch-cache: off bypasses", r.status === 200 && r.json.cached !== true);
  r = await get("/api/cache/stats");
  check("GET /api/cache/stats → hits ≥ 1", r.status === 200 && r.json.hits >= 1);
  await fetch(`${base}/api/cache`, { method: "DELETE", headers: H });
  r = await get("/api/cache/stats");
  check("DELETE /api/cache clears", r.json.entries === 0);

  // ---- costs API ----
  r = await get("/api/costs/summary");
  check("GET /api/costs/summary → monthToDateUsd + forecast",
    r.status === 200 && typeof r.json.monthToDateUsd === "number" && !!r.json.forecast);
  // 2M tokens on mock-model → provider default price used (groq-like? no: mocktest unknown → 0)
  r = await get("/api/costs/forecast");
  check("GET /api/costs/forecast → daily + projectedMonthly",
    r.status === 200 && Array.isArray(r.json.daily) && typeof r.json.projectedMonthly === "number");
  r = await get("/api/costs/export");
  check("GET /api/costs/export → CSV", r.status === 200 && r.text.includes("provider,model,requests"));

  // ---- budgets ----
  const created = await post("/api/keys", { name: "budgeted", budgetUsd: 5 });
  check("POST /api/keys with budgetUsd", created.status === 200 && created.json.budgetUsd === 5);
  const keyId = created.json.id;
  r = await fetch(`${base}/api/keys/${keyId}/budget`, {
    method: "PUT", headers: H, body: JSON.stringify({ budgetUsd: 10 }),
  });
  check("PUT /api/keys/:id/budget", r.status === 200 && (await r.json()).budgetUsd === 10);

  // budget block: $0 budget + block action → 402
  const zero = await post("/api/keys", { name: "zero", budgetUsd: 0 });
  const zeroKey = zero.json.key;
  process.env.BUDGET_ACTION = "block";
  r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${zeroKey}`, "content-type": "application/json" },
    body: JSON.stringify(chatBody),
  });
  check("budget exceeded + block → 402", r.status === 402);
  process.env.BUDGET_ACTION = "warn";
  r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${zeroKey}`, "content-type": "application/json" },
    body: JSON.stringify(chatBody),
  });
  check("budget exceeded + warn → 200 with warning header",
    r.status === 200 && !!r.headers.get("x-llmswitch-budget-warning"));

  // ---- inspector API ----
  r = await get("/api/inspector");
  check("GET /api/inspector → entries", r.status === 200 && r.json.length >= 1 && !!r.json[0].request);
  const firstId = r.json[0].id;
  r = await get(`/api/inspector/${firstId}`);
  check("GET /api/inspector/:id → entry", r.status === 200 && r.json.id === firstId);
  r = await get("/api/inspector/nope");
  check("GET /api/inspector/:id 404", r.status === 404);
} finally {
  upstream.close();
  store.close();
  console.log(failures === 0 ? "\nALL P1 API CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
