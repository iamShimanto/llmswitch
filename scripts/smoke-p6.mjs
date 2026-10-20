#!/usr/bin/env node
/** P6 API smoke: /v1/search, /v1/web/fetch, /v1/web/map. */
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

// mock tavily
const tavily = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ results: [{ title: "R", url: "https://r.example", content: "snip" }] }));
});
await new Promise((r) => tavily.listen(0, "127.0.0.1", r));
process.env.TAVILY_BASE_URL = `http://127.0.0.1:${tavily.address().port}`;
process.env.SEARCH_API_KEY = "test-key";

// local page server
const pages = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<html><head><title>Page</title></head><body>Body text<a href="/next">n</a></body></html>`);
});
await new Promise((r) => pages.listen(0, "127.0.0.1", r));
const pageBase = `http://127.0.0.1:${pages.address().port}`;
process.env.ALLOW_PRIVATE_FETCH = "1";

process.env.PORT = "6390";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-p6";

const config = loadConfig();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, registry.connected(), store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };

try {
  let r = await fetch(`${base}/v1/search`, {
    method: "POST", headers: H, body: JSON.stringify({ query: "test query" }),
  });
  let j = await r.json();
  check("POST /v1/search → normalized results",
    r.status === 200 && j.provider === "tavily" && j.results[0].snippet === "snip");

  r = await fetch(`${base}/v1/search`, { method: "POST", headers: H, body: JSON.stringify({}) });
  check("POST /v1/search without query → 400", r.status === 400);

  delete process.env.SEARCH_API_KEY;
  r = await fetch(`${base}/v1/search`, {
    method: "POST", headers: H, body: JSON.stringify({ query: "x" }),
  });
  check("POST /v1/search without key → 503", r.status === 503);
  process.env.SEARCH_API_KEY = "test-key";

  r = await fetch(`${base}/v1/web/fetch`, {
    method: "POST", headers: H, body: JSON.stringify({ url: `${pageBase}/` }),
  });
  j = await r.json();
  check("POST /v1/web/fetch → title + text",
    r.status === 200 && j.title === "Page" && j.text.includes("Body text"));

  delete process.env.ALLOW_PRIVATE_FETCH;
  r = await fetch(`${base}/v1/web/fetch`, {
    method: "POST", headers: H, body: JSON.stringify({ url: `${pageBase}/` }),
  });
  check("POST /v1/web/fetch loopback without opt-in → 400 (SSRF)", r.status === 400);
  process.env.ALLOW_PRIVATE_FETCH = "1";

  r = await fetch(`${base}/v1/web/fetch`, {
    method: "POST", headers: H, body: JSON.stringify({ url: "ftp://x.y/z" }),
  });
  check("POST /v1/web/fetch ftp → 400", r.status === 400);

  r = await fetch(`${base}/v1/web/map`, {
    method: "POST", headers: H, body: JSON.stringify({ url: `${pageBase}/` }),
  });
  j = await r.json();
  check("POST /v1/web/map → links", r.status === 200 && j.links.includes(`${pageBase}/next`));

  r = await fetch(`${base}/v1/search`, { headers: H });
  const ct = r.headers.get("content-type") ?? "";
  check("GET unknown path → SPA fallback (dashboard)", r.status === 200 && ct.includes("text/html"));
} finally {
  tavily.close();
  pages.close();
  store.close();
  console.log(failures === 0 ? "\nALL P6 API CHECKS PASSED" : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}
