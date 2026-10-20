#!/usr/bin/env node
/**
 * Concurrency smoke: 30 parallel chat requests → all 200, usage rows intact,
 * no SQLITE_BUSY errors.
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
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-1", model: "mock",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
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
process.env.PORT = "6392";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-conc";

const config = loadConfig();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("conc");
const { app } = createServer(config, registry.connected(), store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

try {
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      fetch(`${base}/v1/chat/completions`, {
        method: "POST", headers: H,
        body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: `req ${i}` }] }),
      }).then(async (r) => ({ status: r.status, ok: (await r.json()).choices?.[0]?.message?.content === "ok" })),
    ),
  );
  const ms = Date.now() - t0;
  check("30 parallel requests → all 200 + valid body", results.every((r) => r.status === 200 && r.ok));
  console.log(`    (completed in ${ms}ms)`);
  const rows = store.usageSummary(Date.now() - 3600_000);
  const total = rows.reduce((a, r) => a + r.requests, 0);
  check(`usage rows intact (${total}/30)`, total === 30);
  // budget path under concurrency (budget=0 → any spend check blocks)
  store.setBudget(store.listApiKeys()[0].id, 0);
  process.env.BUDGET_ACTION = "block";
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: H, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "x" }] }),
  });
  check("budget block → 402", r.status === 402);
} finally {
  upstream.close();
  store.close();
  console.log(failures === 0 ? "\nCONCURRENCY CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
