import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-muse-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6132", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const B = "http://127.0.0.1:6132";
const imp = await (await fetch(`${B}/api/sessions/import`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ provider: "muse-spark-web", cookies: "ecto_1_sess=FAKE; datr=x", accessToken: "ecto1:FAKETOKEN" }),
})).json();
console.log("import:", JSON.stringify(imp));
const f = join(dir, "sessions", "muse-spark-web.json");
console.log("session file has token:", existsSync(f) && readFileSync(f, "utf8").includes("ecto1:FAKETOKEN"));
const list = await (await fetch(`${B}/api/providers`)).json();
console.log("connected list has muse:", (list.providers ?? list).some?.((p) => p.id === "muse-spark-web") ?? JSON.stringify(list).includes("muse-spark-web"));
const t = await (await fetch(`${B}/api/providers/muse-spark-web/test`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "muse-spark" }),
})).json();
console.log("test (fake creds, expect clean Meta auth failure):", JSON.stringify(t).slice(0, 190));
srv.kill();
process.exit(0);
