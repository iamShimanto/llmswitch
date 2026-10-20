#!/usr/bin/env node
/**
 * P4 API smoke test: completions, moderations, images/edits, audio/translations,
 * videos, rerank, files, batches.
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
    const json = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/chat/completions") {
      return json({
        id: "chatcmpl-1", model: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "mock reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    if (req.url === "/moderations") return json({ id: "modr-1", model: "m", results: [{ flagged: false }] });
    if (req.url === "/images/edits") return json({ created: 1, data: [{ url: "https://example.com/edit.png" }] });
    if (req.url === "/audio/translations") return json({ text: "translated" });
    if (req.url === "/videos/generations") return json({ id: "job-1", status: "queued" });
    if (req.url === "/rerank") return json({ results: [{ index: 0, relevance_score: 0.9 }] });
    if (req.url === "/files" && req.method === "POST") return json({ id: "file-1", object: "file", purpose: "batch" });
    if (req.url === "/files" && req.method === "GET") return json({ object: "list", data: [{ id: "file-1" }] });
    if (req.url === "/files/file-1" && req.method === "GET") return json({ id: "file-1", object: "file" });
    if (req.url === "/files/file-1/content" && req.method === "GET") return json({ content: "x" });
    if (req.url === "/files/file-1" && req.method === "DELETE") return json({ id: "file-1", deleted: true });
    if (req.url === "/batches" && req.method === "POST") return json({ id: "batch-1", status: "validating" });
    if (req.url === "/batches" && req.method === "GET") return json({ object: "list", data: [{ id: "batch-1" }] });
    if (req.url === "/batches/batch-1" && req.method === "GET") return json({ id: "batch-1", status: "completed" });
    if (req.url === "/batches/batch-1/cancel" && req.method === "POST") return json({ id: "batch-1", status: "cancelling" });
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
process.env.PORT = "6393";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-p4";

const config = loadConfig();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, registry.connected(), store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const HA = { authorization: `Bearer ${key}` }; // no content-type (multipart)

try {
  let r = await fetch(`${base}/v1/completions`, {
    method: "POST", headers: H, body: JSON.stringify({ model: "auto", prompt: "hi" }),
  });
  let j = await r.json();
  check("POST /v1/completions → text_completion", r.status === 200 && j.object === "text_completion" && j.choices[0].text === "mock reply");

  r = await fetch(`${base}/v1/moderations`, { method: "POST", headers: H, body: JSON.stringify({ input: "hi" }) });
  j = await r.json();
  check("POST /v1/moderations", r.status === 200 && j.results[0].flagged === false);

  const form = new FormData();
  form.append("image", new Blob(["x"], { type: "image/png" }), "a.png");
  form.append("prompt", "edit it");
  r = await fetch(`${base}/v1/images/edits`, { method: "POST", headers: HA, body: form });
  j = await r.json();
  check("POST /v1/images/edits", r.status === 200 && j.data[0].url.includes("edit.png"));

  const form2 = new FormData();
  form2.append("file", new Blob(["x"], { type: "audio/wav" }), "a.wav");
  r = await fetch(`${base}/v1/audio/translations`, { method: "POST", headers: HA, body: form2 });
  j = await r.json();
  check("POST /v1/audio/translations", r.status === 200 && j.text === "translated");

  r = await fetch(`${base}/v1/videos/generations`, { method: "POST", headers: H, body: JSON.stringify({ model: "auto", prompt: "a cat" }) });
  j = await r.json();
  check("POST /v1/videos/generations", r.status === 200 && j.id === "job-1");

  r = await fetch(`${base}/v1/rerank`, { method: "POST", headers: H, body: JSON.stringify({ query: "q", documents: ["a", "b"] }) });
  j = await r.json();
  check("POST /v1/rerank", r.status === 200 && j.results[0].relevance_score === 0.9);

  const form3 = new FormData();
  form3.append("file", new Blob(["a"], { type: "application/json" }), "b.jsonl");
  form3.append("purpose", "batch");
  r = await fetch(`${base}/v1/files`, { method: "POST", headers: HA, body: form3 });
  j = await r.json();
  check("POST /v1/files", r.status === 200 && j.id === "file-1");
  r = await fetch(`${base}/v1/files`, { headers: H });
  check("GET /v1/files", r.status === 200 && (await r.json()).data[0].id === "file-1");
  r = await fetch(`${base}/v1/files/file-1`, { headers: H });
  check("GET /v1/files/:id", r.status === 200);
  r = await fetch(`${base}/v1/files/file-1/content`, { headers: H });
  check("GET /v1/files/:id/content", r.status === 200);
  r = await fetch(`${base}/v1/files/file-1`, { method: "DELETE", headers: H });
  check("DELETE /v1/files/:id", r.status === 200 && (await r.json()).deleted === true);

  r = await fetch(`${base}/v1/batches`, { method: "POST", headers: H, body: JSON.stringify({ input_file_id: "file-1", endpoint: "/v1/chat/completions" }) });
  j = await r.json();
  check("POST /v1/batches", r.status === 200 && j.id === "batch-1");
  r = await fetch(`${base}/v1/batches`, { headers: H });
  check("GET /v1/batches", r.status === 200);
  r = await fetch(`${base}/v1/batches/batch-1`, { headers: H });
  check("GET /v1/batches/:id", r.status === 200 && (await r.json()).status === "completed");
  r = await fetch(`${base}/v1/batches/batch-1/cancel`, { method: "POST", headers: H });
  check("POST /v1/batches/:id/cancel", r.status === 200);
} finally {
  upstream.close();
  store.close();
  console.log(failures === 0 ? "\nALL P4 API CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
