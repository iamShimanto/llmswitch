import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "llmswitch-acct-"));
const srv = spawn("node", ["packages/core/dist/index.js"], {
  env: { ...process.env, PORT: "6131", DATA_DIR: dir }, stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3500));
const B = "http://127.0.0.1:6131";
const J = { "content-type": "application/json" };
const fail = (m) => { console.log("FAIL:", m); srv.kill(); process.exit(1); };

// 1) default key connect
let r = await (await fetch(`${B}/api/providers/groq/key`, { method: "POST", headers: J, body: JSON.stringify({ key: "sk-default" }) })).json();
if (!r.connected) fail("groq default key did not connect: " + JSON.stringify(r));
console.log("1. default key connected");

// 2) second account via accountLabel
r = await (await fetch(`${B}/api/providers/groq/key`, { method: "POST", headers: J, body: JSON.stringify({ key: "sk-second", accountLabel: "Backup" }) })).json();
if (!r.accountId) fail("account add returned no accountId: " + JSON.stringify(r));
const acctId = r.accountId;
console.log("2. account added:", acctId);

// 3) accounts list — no secret leakage
r = await (await fetch(`${B}/api/accounts?provider=groq`)).json();
if (r.accounts.length !== 1 || r.accounts[0].label !== "Backup") fail("accounts list wrong: " + JSON.stringify(r));
if (JSON.stringify(r).includes("sk-second")) fail("SECRET LEAKED in accounts list");
console.log("3. accounts list ok, no secret leakage");

// 4) routing rule CRUD
r = await (await fetch(`${B}/api/routing-rules`, { method: "POST", headers: J, body: JSON.stringify({ pattern: "llama-*", providers: ["groq"], strategy: "" }) })).json();
if (!r.rule?.id) fail("rule add failed: " + JSON.stringify(r));
const ruleId = r.rule.id;
r = await (await fetch(`${B}/api/routing-rules`)).json();
if (r.rules.length !== 1 || r.rules[0].pattern !== "llama-*") fail("rules list wrong");
console.log("4. routing rule created + listed");

// 5) account strategy via config
r = await (await fetch(`${B}/api/config`, { method: "PUT", headers: J, body: JSON.stringify({ account_strategy: "least-used" }) })).json();
if (r.account_strategy?.value !== "least-used") fail("account_strategy not saved: " + JSON.stringify(r.account_strategy));
console.log("5. account_strategy = least-used saved");

// 6) disable + delete account
r = await (await fetch(`${B}/api/accounts/${acctId}`, { method: "POST", headers: J, body: JSON.stringify({ enabled: false }) })).json();
if (!r.ok) fail("account disable failed");
r = await (await fetch(`${B}/api/accounts/${acctId}`, { method: "DELETE" })).json();
if (!r.ok) fail("account delete failed");
r = await (await fetch(`${B}/api/accounts?provider=groq`)).json();
if (r.accounts.length !== 0) fail("account still listed after delete");
console.log("6. account disable + delete ok");

// 7) session account via cookie import (chatgpt-web-free is a cookie provider)
r = await (await fetch(`${B}/api/sessions/import`, { method: "POST", headers: J, body: JSON.stringify({ provider: "chatgpt-web-free", cookies: "a=b; c=d", accountLabel: "Alt profile" }) })).json();
if (!r.accountId) fail("cookie account import failed: " + JSON.stringify(r));
r = await (await fetch(`${B}/api/accounts?provider=chatgpt-web-free`)).json();
if (r.accounts.length !== 1 || r.accounts[0].kind !== "session") fail("cookie account not listed");
console.log("7. cookie session account imported + listed");

// 8) rule cleanup
await fetch(`${B}/api/routing-rules/${ruleId}`, { method: "DELETE" });
r = await (await fetch(`${B}/api/routing-rules`)).json();
if (r.rules.length !== 0) fail("rule delete failed");
console.log("8. rule deleted");
console.log("ALL ACCT E2E OK");
srv.kill();
process.exit(0);
