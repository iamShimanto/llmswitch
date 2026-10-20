#!/usr/bin/env node
/** P5 API smoke: explain/routing, upscale, multimodal-embeddings, tts extras,
 *  count_tokens, models/query, quotas/check, me/status, batches/delete-completed. */
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
    const json = (obj, code = 200, ct = "application/json") => {
      res.writeHead(code, { "content-type": ct });
      res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
    };
    if (req.url === "/chat/completions") {
      return json({
        id: "chatcmpl-1", model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    if (req.url === "/images/upscale") return json({ created: 1, data: [{ url: "https://example.com/up.png" }] });
    if (req.url === "/multimodal-embeddings") return json({ data: [{ embedding: [0.3] }] });
    if (req.url === "/audio/speech") return json("FAKEAUDIO2", 200, "audio/mpeg");
    if (req.url === "/voices") { res.writeHead(500); return res.end("{}"); } // force fallback list
    if (req.url === "/audio/transcriptions") return json({ text: "stt ok" });
    if (req.url === "/batches/delete-completed") return json({ deleted: 2 });
    res.writeHead(404); res.end("{}");
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
process.env.PORT = "6391";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-p5";

const config = loadConfig();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, registry.connected(), store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const HA = { authorization: `Bearer ${key}` };

try {
  // seed one routed event
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: H,
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }] }),
  });

  let r = await fetch(`${base}/v1/explain/routing`, { headers: H });
  let j = await r.json();
  check("GET /v1/explain/routing → events + quality",
    r.status === 200 && j.events.length >= 1 && j.events[0].type === "routed" && j.quality.mocktest.calls >= 1);

  const form = new FormData();
  form.append("image", new Blob(["x"], { type: "image/png" }), "a.png");
  r = await fetch(`${base}/v1/images/upscale`, { method: "POST", headers: HA, body: form });
  check("POST /v1/images/upscale", r.status === 200 && (await r.json()).data[0].url.includes("up.png"));

  r = await fetch(`${base}/v1/multimodal-embeddings`, {
    method: "POST", headers: H, body: JSON.stringify({ model: "auto", input: "img" }),
  });
  check("POST /v1/multimodal-embeddings", r.status === 200);

  r = await fetch(`${base}/v1/text-to-speech/nova`, {
    method: "POST", headers: H, body: JSON.stringify({ model: "auto", input: "hello" }),
  });
  check("POST /v1/text-to-speech/:voiceId → audio",
    r.status === 200 && r.headers.get("content-type") === "audio/mpeg");

  r = await fetch(`${base}/v1/voices`, { headers: H });
  j = await r.json();
  check("GET /v1/voices → fallback list", r.status === 200 && j.voices.length === 6);

  const form2 = new FormData();
  form2.append("file", new Blob(["x"], { type: "audio/wav" }), "a.wav");
  r = await fetch(`${base}/v1/speech-to-text`, { method: "POST", headers: HA, body: form2 });
  check("POST /v1/speech-to-text", r.status === 200 && (await r.json()).text === "stt ok");

  r = await fetch(`${base}/v1/messages/count_tokens`, {
    method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "12345678" }] }),
  });
  check("POST /v1/messages/count_tokens", r.status === 200 && (await r.json()).input_tokens === 2);

  r = await fetch(`${base}/v1/responses/input_tokens`, {
    method: "POST", headers: H, body: JSON.stringify({ input: "12345678" }),
  });
  check("POST /v1/responses/input_tokens", r.status === 200 && (await r.json()).input_tokens === 2);

  r = await fetch(`${base}/v1/models/query?q=mock`, { headers: H });
  check("GET /v1/models/query", r.status === 200 && (await r.json()).data.length >= 1);

  r = await fetch(`${base}/v1/quotas/check`, { headers: H });
  check("GET /v1/quotas/check", r.status === 200 && (await r.json()).providers[0].id === "mocktest");

  r = await fetch(`${base}/v1/me/status`, { headers: H });
  j = await r.json();
  check("GET /v1/me/status", r.status === 200 && j.name === "smoke" && typeof j.monthSpendUsd === "number");

  r = await fetch(`${base}/v1/batches/delete-completed`, { method: "POST", headers: H });
  check("POST /v1/batches/delete-completed", r.status === 200 && (await r.json()).deleted === 2);
} finally {
  upstream.close();
  store.close();
  console.log(failures === 0 ? "\nALL P5 API CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
