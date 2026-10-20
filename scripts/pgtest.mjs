import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-pg-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6127", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const B = "http://127.0.0.1:6127";
const r = await (await fetch(`${B}/api/playground`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ providers: ["ovhcloud", "duckduckgo-web"], messages: [{ role: "user", content: "Explain recursion in one sentence." }] }),
})).json();
for (const x of r.results) console.log(x.providerId, "ok:", x.ok, "|", (x.text ?? x.error ?? "").slice(0, 90));
const s = await (await fetch(`${B}/api/analytics/summary?days=30`)).json();
console.log("analytics after playground: requests =", s.totals.requests, "byProvider =", s.byProvider.map((p) => `${p.provider}:${p.requests}`).join(", "));
srv.kill();
process.exit(0);
