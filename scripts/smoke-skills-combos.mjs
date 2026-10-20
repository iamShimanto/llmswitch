#!/usr/bin/env node
/** E2E: skills + combos routes against a mock upstream. */
import http from "node:http";
import { registry } from "../packages/core/dist/providers/registry.js";
import { loadConfig } from "../packages/core/dist/config.js";
import { createServer, listenWithFallback } from "../packages/core/dist/server.js";
import { Store } from "../packages/core/dist/store/db.js";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "  ✅" : "  ❌"} ${name}${extra && !cond ? " — " + extra : ""}`);
  if (!cond) failures++;
}

const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const sys = (j.messages || []).find((m) => m.role === "system")?.content ?? "";
    const user = (j.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("|");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-1", model: "mock-model",
      choices: [{ index: 0, message: { role: "assistant", content: `SYS[${sys.slice(0, 20)}] USER[${user}]` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    }));
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const mockPort = upstream.address().port;

registry.register({
  id: "mocktest", name: "MockTest", baseUrl: `http://127.0.0.1:${mockPort}`,
  wireFormat: "openai", envKey: "MOCKTEST_API_KEY", envBaseUrl: "MOCKTEST_BASE_URL",
  models: ["mock-model"], defaultModel: "mock-model", costTier: 1,
});
process.env.MOCKTEST_API_KEY = "x";
process.env.PORT = "6499";
process.env.DATA_DIR = "/tmp/llmswitch-smoke-skills";
process.env.LLMSWITCH_SKILLS_DIR = "/tmp/llmswitch-smoke-skills-files";

const config = loadConfig();
const providers = registry.connected();
const store = new Store(config.dataDir);
const { key } = store.createApiKey("smoke");
const { app } = createServer(config, providers, store);
const { port } = await listenWithFallback(app, config.port);
const base = `http://127.0.0.1:${port}`;
const H = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const A = { "content-type": "application/json" }; // /api/* (no admin key set)

try {
  // skills: builtins listed
  let r = await fetch(`${base}/api/skills`, { headers: A });
  let j = await r.json();
  check("GET /api/skills lists builtins", j.skills?.some((s) => s.name === "summarize") && j.skills?.some((s) => s.name === "translate-bn"));

  // create custom skill
  r = await fetch(`${base}/api/skills`, { method: "POST", headers: A, body: JSON.stringify({ name: "shout", description: "shout it", instructions: "Reply in ALL CAPS." }) });
  check("POST /api/skills → 201", r.status === 201);

  // run builtin skill
  r = await fetch(`${base}/v1/skills/summarize/run`, { method: "POST", headers: H, body: JSON.stringify({ input: "The cat sat." }) });
  j = await r.json();
  check("POST /v1/skills/summarize/run → 200 + output", r.status === 200 && j.output?.includes("USER[The cat sat.]"), JSON.stringify(j).slice(0, 200));
  check("skill run used system prompt", j.output?.includes("SYS[You are a precise"));

  // run custom skill
  r = await fetch(`${base}/v1/skills/shout/run`, { method: "POST", headers: H, body: JSON.stringify({ input: "hello" }) });
  j = await r.json();
  check("custom skill run works", r.status === 200 && j.output?.includes("SYS[Reply in ALL CAPS.]"));

  // unknown skill → 404
  r = await fetch(`${base}/v1/skills/nope/run`, { method: "POST", headers: H, body: JSON.stringify({ input: "x" }) });
  check("unknown skill → 404", r.status === 404);

  // missing input → 400
  r = await fetch(`${base}/v1/skills/summarize/run`, { method: "POST", headers: H, body: JSON.stringify({}) });
  check("missing input → 400", r.status === 400);

  // delete custom skill
  r = await fetch(`${base}/api/skills/shout`, { method: "DELETE", headers: A });
  check("DELETE /api/skills/shout → 200", r.status === 200 && (await r.json()).deleted === true);

  // combos: create
  r = await fetch(`${base}/api/combos`, { method: "POST", headers: A, body: JSON.stringify({
    name: "draft-polish", description: "draft then polish",
    steps: [{ model: "mocktest:mock-model" }, { model: "mocktest:mock-model", system: "Polish the text." }],
  }) });
  check("POST /api/combos → 201", r.status === 201);

  // list combos
  r = await fetch(`${base}/api/combos`, { headers: A });
  j = await r.json();
  check("GET /api/combos lists it", j.combos?.some((c) => c.name === "draft-polish"));

  // run combo
  r = await fetch(`${base}/v1/combos/draft-polish/run`, { method: "POST", headers: H, body: JSON.stringify({ input: "rough text" }) });
  j = await r.json();
  check("POST /v1/combos/draft-polish/run → 200, 2 steps", r.status === 200 && j.steps?.length === 2, JSON.stringify(j).slice(0, 200));
  check("combo step2 got step1 output", j.steps?.[1]?.output?.includes(j.steps?.[0]?.output?.slice(0, 20) ?? "___"));
  check("combo totals present", typeof j.total_cost_usd === "number" && typeof j.total_latency_ms === "number");

  // unknown combo → 404
  r = await fetch(`${base}/v1/combos/nope/run`, { method: "POST", headers: H, body: JSON.stringify({ input: "x" }) });
  check("unknown combo → 404", r.status === 404);

  // bad combo → 400
  r = await fetch(`${base}/api/combos`, { method: "POST", headers: A, body: JSON.stringify({ name: "Bad Name!", steps: [] }) });
  check("bad combo → 400", r.status === 400);

  // delete combo
  r = await fetch(`${base}/api/combos/draft-polish`, { method: "DELETE", headers: A });
  check("DELETE /api/combos → 200", r.status === 200);

  // /v1 run without gateway key → 401
  r = await fetch(`${base}/v1/skills/summarize/run`, { method: "POST", headers: A, body: JSON.stringify({ input: "x" }) });
  check("skill run without key → 401", r.status === 401);
} finally {
  upstream.close();
  process.exit(failures ? 1 : 0);
}
