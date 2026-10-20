import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-ddg-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6124", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 4000));
const t = await fetch("http://127.0.0.1:6124/api/providers/duckduckgo-web/test", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-5.4-mini" }),
}).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
console.log("DDG live test:", JSON.stringify(t).slice(0, 300));
srv.kill();
process.exit(0);
