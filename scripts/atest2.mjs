import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-an-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6125", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const B = "http://127.0.0.1:6125";
const key = await (await fetch(`${B}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "t" }) })).json();
await fetch(`${B}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify({ model: "ovhcloud:Meta-Llama-3_3-70B-Instruct", messages: [{ role: "user", content: "Say hi" }] }) });
const s = await (await fetch(`${B}/api/analytics/summary?days=30`)).json();
console.log("totals:", JSON.stringify(s.totals));
console.log("series days:", s.series.length, "| byProvider:", s.byProvider.map((p) => p.provider).join(","), "| infra:", JSON.stringify(s.infra));
const seeded = await (await fetch(`${B}/api/inspector`)).json();
console.log("inspector entries (seeded incl.):", seeded.length);
srv.kill();
process.exit(0);
