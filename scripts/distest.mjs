import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-dt-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6122", DATA_DIR: dir, GROQ_API_KEY: "fake" }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const d = await fetch("http://127.0.0.1:6122/api/providers/groq/discover");
const j = await d.json();
console.log("groq discover (fake key):", d.status, "models:", j.models?.length, "note:", j.note ?? "(none)");
srv.kill();
process.exit(0);
