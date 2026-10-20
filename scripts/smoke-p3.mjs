#!/usr/bin/env node
/**
 * P3 API smoke test: Responses API, embeddings, images, audio.
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
    const raw = Buffer.concat(body);
    const json = (obj) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/chat/completions") {
      return json({
        id: "chatcmpl-1", model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (req.url === "/embeddings") {
      return json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "mock", usage: { prompt_tokens: 3, total_tokens: 3 } });
    }
    if (req.url === "/images/generations") {
      return json({ created: 1, data: [{ url: "https://example.com/img.png" }] });
    }
    if (req.url === "/audio/speech") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(Buffer.from("FAKEAUDIO"));
    }
    if (req.url === "/audio/transcriptions") {
      return json({ text: "hello world" });
    }
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
process.env.PORT = "6394";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-p3";

const config = loadConfig();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, registry.connected(), store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

try {
  // ---- Responses API (non-stream) ----
  let r = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: H,
    body: JSON.stringify({ model: "auto", input: "say hi", instructions: "be brief" }),
  });
  let j = await r.json();
  check("POST /v1/responses → response object", r.status === 200 && j.object === "response" && j.status === "completed");
  check("responses output text", j.output[0].content[0].text === "mock reply");
  check("responses usage mapped", j.usage.total_tokens === 15);

  // ---- Responses API (stream) ----
  r = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: H,
    body: JSON.stringify({ model: "auto", input: "say hi", stream: true }),
  });
  const sse = await r.text();
  check("POST /v1/responses stream → SSE events",
    r.status === 200 && sse.includes("response.created") && sse.includes("response.completed"));

  r = await fetch(`${base}/v1/responses`, { method: "POST", headers: H, body: JSON.stringify({ input: "x" }) });
  check("POST /v1/responses without model → 400", r.status === 400);

  // ---- Embeddings ----
  r = await fetch(`${base}/v1/embeddings`, {
    method: "POST", headers: H,
    body: JSON.stringify({ model: "auto", input: "hello" }),
  });
  j = await r.json();
  check("POST /v1/embeddings → passthrough", r.status === 200 && j.data[0].embedding.length === 2);

  // ---- Images ----
  r = await fetch(`${base}/v1/images/generations`, {
    method: "POST", headers: H,
    body: JSON.stringify({ model: "auto", prompt: "a cat" }),
  });
  j = await r.json();
  check("POST /v1/images/generations → passthrough", r.status === 200 && j.data[0].url.includes("img.png"));

  // ---- Audio speech ----
  r = await fetch(`${base}/v1/audio/speech`, {
    method: "POST", headers: H,
    body: JSON.stringify({ model: "auto", input: "hello" }),
  });
  const ab = await r.arrayBuffer();
  check("POST /v1/audio/speech → audio bytes",
    r.status === 200 && r.headers.get("content-type") === "audio/mpeg" && ab.byteLength === 9);

  // ---- Audio transcriptions (multipart) ----
  const form = new FormData();
  form.append("file", new Blob(["fakedata"], { type: "audio/wav" }), "a.wav");
  form.append("model", "mock-model");
  r = await fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  j = await r.json();
  check("POST /v1/audio/transcriptions → text", r.status === 200 && j.text === "hello world");
} finally {
  upstream.close();
  store.close();
  console.log(failures === 0 ? "\nALL P3 API CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
