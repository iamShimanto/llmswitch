#!/usr/bin/env node
/**
 * Smoke test: boots the real gateway against a MOCK OpenAI-wire upstream and
 * exercises health, models, chat (JSON + SSE), auth failures, fallback,
 * usage logging and dashboard serving. Exit non-zero on any failure.
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

// ---- mock upstream (OpenAI wire) ----
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.startsWith("/boom")) {
      res.writeHead(500);
      res.end("boom");
      return;
    }
    const j = JSON.parse(body || "{}");
    if (j.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"id":"1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      );
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "mock-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from mock" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      );
    }
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const mockPort = upstream.address().port;

// sick provider FIRST (priority) to prove fallback; healthy mock second
registry.register({
  id: "sick",
  name: "Sick",
  baseUrl: `http://127.0.0.1:${mockPort}/boom-base`,
  wireFormat: "openai",
  envKey: "SICK_API_KEY",
  envBaseUrl: "SICK_BASE_URL",
  models: ["mock-model"],
  defaultModel: "mock-model",
  costTier: 5,
});
registry.register({
  id: "mocktest",
  name: "MockTest",
  baseUrl: `http://127.0.0.1:${mockPort}`,
  wireFormat: "openai",
  envKey: "MOCKTEST_API_KEY",
  envBaseUrl: "MOCKTEST_BASE_URL",
  models: ["mock-model"],
  defaultModel: "mock-model",
  costTier: 1,
});
// make "sick" fail: point it at /boom path via baseUrl override
process.env.SICK_API_KEY = "x";
process.env.SICK_BASE_URL = `http://127.0.0.1:${mockPort}/boom`;
process.env.MOCKTEST_API_KEY = "x";
process.env.PORT = "6399";
process.env.DATA_DIR = "/tmp/llmswitch-smoke";

const config = loadConfig();
const providers = registry.connected().filter((p) => p.id === "sick" || p.id === "mocktest");
check("two providers connected", providers.length === 2);

const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, providers, store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

try {
  // health (no auth)
  let r = await fetch(`${base}/healthz`);
  check("GET /healthz → 200", r.status === 200);

  // models (auth)
  r = await fetch(`${base}/v1/models`, { headers: H });
  const models = await r.json();
  check("GET /v1/models lists auto + mock", models.data.some((m) => m.id === "auto"));

  // chat JSON — sick is first in priority, must fall back to mocktest
  r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });
  const chat = await r.json();
  check("POST /v1/chat/completions → 200", r.status === 200);
  check("fallback worked (content from mock)", chat.choices?.[0]?.message?.content === "Hello from mock");
  check("provider attributed", chat.provider === "mocktest");

  // chat SSE
  r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const text = await r.text();
  check("SSE stream 200 + chunks + [DONE]", r.status === 200 && text.includes('"content":"Hel"') && text.includes("[DONE]"));

  // auth failures
  r = await fetch(`${base}/v1/models`);
  check("no token → 401", r.status === 401);
  r = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer lsk_wrong" } });
  check("bad token → 401", r.status === 401);

  // usage logged
  r = await fetch(`${base}/api/usage`, { headers: H });
  const usage = await r.json();
  check("usage logged", Array.isArray(usage) && usage.length > 0);

  // dashboard served
  r = await fetch(`${base}/`);
  const html = await r.text();
  check("dashboard served", r.status === 200 && html.includes("LLMSwitch"));

  // explicit provider:model
  r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      model: "mocktest:mock-model",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  check("provider:model routing → 200", r.status === 200);
} finally {
  upstream.close();
  store.close();
  process.exit(failures === 0 ? 0 : 1);
}
