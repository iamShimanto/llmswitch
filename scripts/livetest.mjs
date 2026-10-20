import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-lv-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6123", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const B = "http://127.0.0.1:6123";
// create a gateway key + open the stream
const key = await (await fetch(`${B}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "t" }) })).json();
const ac = new AbortController();
const streamRes = await fetch(`${B}/api/live`, { signal: ac.signal });
const reader = streamRes.body.getReader();
let received = "";
const pump = (async () => {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += new TextDecoder().decode(value);
    if (received.includes("event: request")) break;
  }
})();
// fire a chat request (keyless OVH)
await fetch(`${B}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
  body: JSON.stringify({ model: "ovhcloud:Meta-Llama-3_3-70B-Instruct", messages: [{ role: "user", content: "Say hi" }] }),
}).catch(() => {});
await Promise.race([pump, new Promise((r) => setTimeout(r, 30000))]);
ac.abort();
srv.kill();
console.log("snapshot received:", received.includes("event: snapshot"));
console.log("live request event received:", received.includes("event: request"));
const m = received.match(/event: request\ndata: (.+)/);
if (m) { const e = JSON.parse(m[1]); console.log("entry:", e.provider, e.model, e.status, e.latencyMs + "ms"); }
process.exit(0);
