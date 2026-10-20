import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-lg-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6126", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const B = "http://127.0.0.1:6126";
const key = await (await fetch(`${B}/api/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "t" }) })).json();
await fetch(`${B}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify({ model: "ovhcloud:Meta-Llama-3_3-70B-Instruct", messages: [{ role: "user", content: "Say hi" }] }) });
await fetch(`${B}/api/providers/duckduckgo-web/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
const all = await (await fetch(`${B}/api/logs`)).json();
console.log("total logs:", all.total, "| providers:", all.logs.map((l) => l.provider).join(","));
const f = await (await fetch(`${B}/api/logs?provider=ovhcloud`)).json();
console.log("filtered ovhcloud:", f.total, "| first has request preview:", (f.logs[0]?.request?.length ?? 0) > 0);
srv.kill();
process.exit(0);
