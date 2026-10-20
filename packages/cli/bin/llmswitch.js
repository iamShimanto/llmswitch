#!/usr/bin/env node
/**
 * llmswitch CLI
 *   llmswitch serve [--port 6000] [--data-dir ./data]   start the gateway (default)
 *   llmswitch providers                                 list connected providers
 *   llmswitch test                                      ping every connected provider
 *   llmswitch chat "prompt" [--model auto]             one-shot chat via router
 *   llmswitch models [query]                           list models (optional filter)
 *   llmswitch doctor                                   environment health check
 *   llmswitch keys                                      list API keys
 *   llmswitch compress [mode] <text>                   compression preview
 *   llmswitch mcp                                      start MCP server (stdio)
 *   llmswitch login [name] --provider github --client-id <id>   OAuth device-flow login
 *   llmswitch logout [name] / sessions                manage saved sessions
 *   llmswitch cookies <name> --domain <d> [--file f]  import browser cookies
 *   llmswitch cookie-chat <sess> --url <endpoint> "prompt"   chat via cookie session
 *   llmswitch chat --repl [--model m]                  multi-turn REPL
 *   llmswitch setup [--tool cursor|vscode|cline|continue]   coding-tool config wizard
 *   llmswitch bench [--model p:m] [--runs n]          latency benchmark per provider
 *   llmswitch quota                                   rate-limit quota table
 *   llmswitch costs [--days n]                        cost report from usage log
 *   llmswitch completion [bash|zsh]                   shell completions
 */
import { createRouter, detectLocalProviders, loadConfig, registry, start } from "@llmswitch/core";

function flag(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function withLocal() {
  try {
    for (const def of await detectLocalProviders()) registry.register(def);
  } catch { /* never blocks */ }
  return registry.connected();
}

async function cmdProviders() {
  const providers = await withLocal();
  if (providers.length === 0) {
    console.log("No providers connected. Set an API key env var (e.g. GROQ_API_KEY) and retry.");
    return;
  }
  console.log("Connected providers:");
  for (const p of providers) {
    console.log(`  • ${p.id} (${p.name}) — default: ${p.defaultModel} — ${p.models.length} models`);
  }
}

async function cmdTest() {
  const config = loadConfig();
  const providers = await withLocal();
  if (providers.length === 0) {
    console.log("No providers connected. Set an API key env var (e.g. GROQ_API_KEY) and retry.");
    process.exit(1);
  }
  const router = createRouter(providers);
  console.log(`Pinging ${providers.length} provider(s) with strategy=${config.strategy}…`);
  for (const p of providers) {
    const started = Date.now();
    try {
      const r = await router.route(
        { model: `${p.id}:${p.defaultModel}`, messages: [{ role: "user", content: "Reply with: ok" }] },
        { timeoutMs: 30_000 },
      );
      const text = (r.response?.choices[0]?.message.content ?? "").slice(0, 60);
      console.log(`  ✅ ${p.id}: ok (${Date.now() - started}ms) — "${text}"`);
    } catch (err) {
      console.log(`  ❌ ${p.id}: ${err.message?.slice(0, 120)}`);
    }
  }
}

async function cmdChat() {
  if (process.argv.includes("--repl")) return cmdChatRepl();
  const prompt = process.argv[3];
  if (!prompt) {
    console.error('usage: llmswitch chat "prompt" [--model auto] [--system "..."]\n       llmswitch chat --repl [--model auto]  (multi-turn REPL; /model <m>, /quit)');
    process.exit(1);
  }
  const providers = await withLocal();
  if (providers.length === 0) {
    console.log("No providers connected. Set an API key env var (e.g. GROQ_API_KEY) and retry.");
    process.exit(1);
  }
  const router = createRouter(providers);
  const messages = [];
  const system = flag("--system");
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const r = await router.route({ model: flag("--model") || "auto", messages });
  console.log(`[${r.providerId}/${r.model}]`);
  console.log(r.response?.choices[0]?.message.content ?? "");
}

async function cmdModels() {
  const q = (process.argv[3] || "").toLowerCase();
  const providers = await withLocal();
  const rows = [];
  for (const p of providers) {
    for (const m of p.models) {
      if (!q || m.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) {
        rows.push(`${p.id}:${m}`);
      }
    }
  }
  if (!rows.length) {
    console.log("No models found. Set a provider API key first.");
    return;
  }
  console.log(rows.join("\n"));
}

async function cmdDoctor() {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const checks = [];
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 22;
  checks.push([nodeOk, `node ${process.versions.node} (>=22 required)`]);
  const providers = await withLocal();
  checks.push([providers.length > 0, `${providers.length} provider(s) connected`]);
  const config = loadConfig();
  let dbOk = true;
  try {
    const { Store } = await import("@llmswitch/core");
    const s = new Store(config.dataDir);
    s.close();
  } catch { dbOk = false; }
  checks.push([dbOk, `data dir writable (${config.dataDir})`]);
  const dashBuilt = existsSync(join(process.cwd(), "packages", "dashboard", "dist", "index.html"));
  checks.push([dashBuilt, "dashboard built"]);
  checks.push([!!process.env.SEARCH_API_KEY, "SEARCH_API_KEY set (web search)"]);
  let failed = 0;
  for (const [ok, label] of checks) {
    console.log(`  ${ok ? "✅" : "❌"} ${label}`);
    if (!ok) failed++;
  }
  if (failed) process.exit(1);
}

async function cmdKeys() {
  const { Store } = await import("@llmswitch/core");
  const config = loadConfig();
  const store = new Store(config.dataDir);
  const keys = store.listApiKeys();
  store.close();
  if (keys.length === 0) {
    console.log("No API keys yet. Create one in the dashboard or via POST /api/keys.");
    return;
  }
  console.log("API keys:");
  for (const k of keys) {
    console.log(`  • ${k.name} (${k.id}) — ${k.rpmLimit} rpm${k.budgetUsd != null ? ` — $${k.budgetUsd}/mo` : ""} — ws:${k.workspaceId}`);
  }
}

async function cmdCompress() {
  const { compressText, isCompressionMode } = await import("@llmswitch/core");
  const mode = isCompressionMode(process.argv[3]) ? process.argv[3] : "stacked";
  const text = process.argv.slice(isCompressionMode(process.argv[3]) ? 4 : 3).join(" ");
  if (!text) {
    console.error("usage: llmswitch compress [caveman|rtk|stacked] <text>");
    process.exit(1);
  }
  const r = compressText(text, mode);
  console.log(r.text);
  console.error(`saved ${r.stats.savedChars} chars (${r.stats.savedPct}%) · ~${r.stats.estTokensBefore} → ~${r.stats.estTokensAfter} tokens`);
}

/**
 * Google Antigravity login (unofficial OAuth flow).
 *   llmswitch login antigravity                          browser loopback sign-in
 *   llmswitch login antigravity --refresh-token <rt>     import an existing refresh token
 * After login, route via the gateway:  model "antigravity:<model-id>"
 * (e.g. antigravity:claude-sonnet-4-6, antigravity:gemini-3.8-flash-high).
 */
async function cmdLoginAntigravity() {
  const { loginWithLoopback, loginWithRefreshToken } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: this signs in with YOUR Google account against Google's\n" +
    "internal Cloud Code API (the Antigravity IDE backend). It is reverse-engineered,\n" +
    "not Google-supported — Google may block/revoke it, and it may violate ToS.\n" +
    "Your account can be limited or banned. Continue only with your own account.\n",
  );
  const rt = flag("--refresh-token");
  let session;
  if (rt) {
    session = await loginWithRefreshToken(rt);
  } else {
    session = await loginWithLoopback({
      onAuthUrl: (url) => {
        console.log("Open this URL in your browser and sign in to Google:\n");
        console.log(`   ${url}\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
      },
    });
  }
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}.`);
  console.log(
    session.projectId
      ? `Cloud Code project: ${session.projectId}`
      : "⚠️  No project id assigned — Google expects a user GCP project (BYOP). Set ANTIGRAVITY_PROJECT_ID.",
  );
  console.log("Session saved. Now route chats with model: antigravity:<model-id>");
}

/**
 * Claude OAuth login (unofficial, Claude Code's public PKCE client).
 *   llmswitch login claude                          browser loopback sign-in
 *   llmswitch login claude --refresh-token <rt>     import an existing refresh token
 * After login, route via the gateway: model "claude:<model-id>".
 */
async function cmdLoginClaude() {
  const ws = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: this signs in with YOUR Anthropic account against the\n" +
    "Claude Code OAuth client (reverse-engineered). Anthropic may restrict it,\n" +
    "and it may violate ToS. Continue only with your own account.\n",
  );
  const rt = flag("--refresh-token");
  let session;
  if (rt) {
    session = await ws.loginClaudeWithRefreshToken(rt);
  } else {
    session = await ws.loginClaudeWithLoopback({
      onAuthUrl: (url) => {
        console.log("Open this URL in your browser and sign in to Anthropic:\n");
        console.log(`   ${url}\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
      },
    });
  }
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}.`);
  console.log("Session saved. Now route chats with model: claude:<model-id>");
}

/**
 * Codex OAuth login (unofficial, Codex CLI's public PKCE client).
 *   llmswitch login codex                          browser loopback sign-in
 *   llmswitch login codex --refresh-token <rt>     import an existing refresh token
 * After login, route via the gateway: model "codex:<model-id>".
 */
async function cmdLoginCodex() {
  const ws = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: this signs in with YOUR OpenAI account against the\n" +
    "Codex CLI OAuth client (reverse-engineered). OpenAI may restrict it, and\n" +
    "it may violate ToS. Continue only with your own account.\n",
  );
  const rt = flag("--refresh-token");
  let session;
  if (rt) {
    session = await ws.loginCodexWithRefreshToken(rt);
  } else {
    session = await ws.loginCodexWithLoopback({
      onAuthUrl: (url) => {
        console.log("Open this URL in your browser and sign in to OpenAI:\n");
        console.log(`   ${url}\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
      },
    });
  }
  console.log(`\nLogged in${session.accountId ? ` (account ${session.accountId})` : ""}.`);
  console.log("Session saved. Now route chats with model: codex:<model-id>");
}

/**
 * Cursor login — deep-control PKCE browser flow (cursor.com/loginDeepControl
 * + auth/poll) or IDE token import.
 *   llmswitch login cursor                          browser sign-in
 *   llmswitch login cursor --access-token <t> [--refresh-token <rt>] [--machine-id <id>]
 * Chat dispatch note: Cursor's chat wire is protobuf Connect-RPC and is NOT
 * ported — logins/imports are fully functional, chat calls return a typed
 * error explaining this.
 */
async function cmdLoginCursor() {
  const { loginCursorWithBrowser, importCursorTokens } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: Cursor's deep-control sign-in (cursor.com) is reverse-engineered\n" +
    "and its endpoints can change without notice. Use your own account and accept the risk.\n" +
    "Note: Cursor's chat wire (protobuf) is not ported in LLMSwitch yet — login works,\nchat calls return an explanatory error.\n",
  );
  const accessToken = flag("--access-token");
  let session;
  if (accessToken) {
    session = await importCursorTokens(accessToken, flag("--refresh-token"), flag("--machine-id"));
  } else {
    session = await loginCursorWithBrowser({
      onAuthUrl: (url) => {
        console.log("Open this URL in your browser and sign in to Cursor:\n");
        console.log(`   ${url}\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
      },
    });
  }
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}. Session saved.`);
}

/**
 * Kiro login — AWS Builder ID (SSO OIDC device flow) by default; social
 * Google/GitHub via --provider; refresh-token import via --refresh-token.
 *   llmswitch login kiro [--provider google|github] [--refresh-token <rt>] [--profile-arn <arn>]
 */
async function cmdLoginKiro() {
  const {
    loginKiroBuilderId, loginKiroSocial, importKiroToken,
  } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: Kiro's ToS prohibits third-party proxy/harness use — your\n" +
    "account can be limited or banned. Use your own account and accept the risk.\n",
  );
  const provider = flag("--provider");
  const rt = flag("--refresh-token");
  let session;
  if (rt || flag("--access-token")) {
    session = await importKiroToken({
      refreshToken: rt,
      accessToken: flag("--access-token"),
      profileArn: flag("--profile-arn"),
    });
  } else if (provider === "google" || provider === "github") {
    session = await loginKiroSocial(provider, {
      onAuthUrl: (url, code) => {
        console.log("Open this URL in your browser and sign in:\n");
        console.log(`   ${url}\n`);
        if (code) console.log(`   (code: ${code})\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel)");
      },
    });
  } else {
    session = await loginKiroBuilderId({
      onAuthUrl: (url, code) => {
        console.log("Open this URL in your browser and sign in with AWS Builder ID:\n");
        console.log(`   ${url}\n`);
        if (code) console.log(`   (code: ${code})\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel)");
      },
    });
  }
  console.log("\nLogged in. Session saved. Route chats with model: kiro:<model-id>");
}

/**
 * Zed Hosted login — native-app RSA-keypair sign-in. The browser redirect
 * lands on http://127.0.0.1:<port>/ (a dead page on other machines) — copy
 * that URL from the address bar and paste it back here.
 *   llmswitch login zed-hosted
 */
async function cmdLoginZedHosted() {
  const { createZedNativeAuthData, loginZedWithPastedCallback } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: zed.dev native-app sign-in is reverse-engineered; Zed can\n" +
    "change it without notice. Use your own account and accept the risk.\n",
  );
  const authData = createZedNativeAuthData({});
  console.log("1) Open this URL in your browser and sign in to Zed:\n");
  console.log(`   ${authData.authUrl}\n`);
  console.log("2) Your browser will try to open a 127.0.0.1 page (\"site can't be reached\" is fine).");
  console.log("   Copy the FULL URL from the address bar and paste it here:");
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const callback = await new Promise((resolve) => rl.question("> ", (a) => { rl.close(); resolve(a.trim()); }));
  if (!callback) {
    console.error("No callback URL provided.");
    process.exit(1);
  }
  const session = await loginZedWithPastedCallback(callback, authData);
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}. Session saved. Route chats with model: zed-hosted:<model-id>`);
}

/**
 * ClinePass login — Cline account OAuth (loopback) or BYOK key import.
 *   llmswitch login clinepass [--api-key <key>]
 */
async function cmdLoginClinepass() {
  const { loginClinePassWithBrowser, importClinePassKey } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: Cline's auth API (api.cline.bot) is reverse-engineered and can\n" +
    "change without notice. Use your own account and accept the risk.\n",
  );
  const apiKey = flag("--api-key");
  let session;
  if (apiKey) {
    session = await importClinePassKey(apiKey);
    console.log("\nAPI key saved (BYOK). Route chats with model: clinepass:<model-id>");
    return;
  }
  session = await loginClinePassWithBrowser({
    onAuthUrl: (url) => {
      console.log("Open this URL in your browser and sign in to Cline:\n");
      console.log(`   ${url}\n`);
      console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
    },
  });
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}. Session saved. Route chats with model: clinepass:<model-id>`);
}

/**
 * Token import for providers where paste is the primary (or only)
 * credential path:
 *   llmswitch import-token trae <cloud-ide-jwt> [--web-id <id>] [--biz-user-id <id>] [--user-unique-id <id>]
 *   llmswitch import-token cursor <accessToken> [refreshToken] [--machine-id <id>]
 *   llmswitch import-token clinepass <api-key>
 *   llmswitch import-token kiro <refreshToken> [--profile-arn <arn>]
 */
async function cmdImportToken() {
  const provider = process.argv[3];
  const token = process.argv[4];
  if (!provider || !token || provider.startsWith("--")) {
    console.error(
      "usage: llmswitch import-token trae <cloud-ide-jwt> [identity flags]\n" +
      "       llmswitch import-token cursor <accessToken> [refreshToken] [--machine-id <id>]\n" +
      "       llmswitch import-token clinepass <api-key>\n" +
      "       llmswitch import-token kiro <refreshToken> [--profile-arn <arn>]\n" +
      "       llmswitch import-token devin-desktop <token>\n" +
      "       llmswitch import-token grok-cli --file <auth.json>  (or --file omitted: stdin)",
    );
    process.exit(1);
  }
  const ws = await import("@llmswitch/web-session");
  if (provider === "trae") {
    const session = await ws.importTraeToken({
      accessToken: token,
      identity: {
        webId: flag("--web-id"),
        bizUserId: flag("--biz-user-id"),
        userUniqueId: flag("--user-unique-id"),
      },
    });
    console.log(
      `Trae token saved (expires ${session.expiresAt ? new Date(session.expiresAt).toISOString() : "unknown"}; ` +
      "~14-day lifetime, no refresh — re-import on expiry).",
    );
  } else if (provider === "cursor") {
    const refreshToken = process.argv[5] && !process.argv[5].startsWith("--") ? process.argv[5] : undefined;
    await ws.importCursorTokens(token, refreshToken, flag("--machine-id"));
    console.log("Cursor tokens saved.");
  } else if (provider === "clinepass") {
    await ws.importClinePassKey(token);
    console.log("ClinePass API key saved (BYOK).");
  } else if (provider === "devin-desktop") {
    const session = await ws.saveDevinDesktopToken(token);
    console.log("Devin Desktop token saved. (Connect transport not yet implemented — see BUILD_STATUS.md P11-I)");
    void session;
  } else if (provider === "grok-cli") {
    let text = token;
    if (!text || text === "--file") {
      const file = flag("--file");
      const { readFileSync } = await import("node:fs");
      text = file ? readFileSync(file, "utf8") : await new Promise((res) => { let d = ""; process.stdin.on("data", (c) => (d += c)); process.stdin.on("end", () => res(d)); });
    }
    await ws.importGrokAuthJson(text);
    console.log("Grok CLI auth.json imported. Route chats with model: grok-cli:<model-id>");
  } else if (provider === "kiro") {
    await ws.importKiroToken({ refreshToken: token, profileArn: flag("--profile-arn") });
    console.log("Kiro refresh token saved.");
  } else {
    console.error(`import-token: unsupported provider "${provider}" (use trae|cursor|clinepass|kiro)`);
    process.exit(1);
  }
}

/**
 * P11-I OAuth cluster (OmniRoute-style, all unofficial/reverse-engineered):
 *   llmswitch login codebuddy-cn|codebuddy-intl|workbuddy  (Tencent device flow)
 *   llmswitch login grok-cli                                (xAI device flow / import)
 *   llmswitch login openference                             (PKCE browser loopback)
 *   llmswitch login gitlab-duo                              (PKCE; needs GITLAB_DUO_OAUTH_CLIENT_ID)
 *   llmswitch login agy [--refresh-token <rt>]              (Google, = antigravity client)
 *   llmswitch import-token devin-desktop <token>            (paste from the app)
 *   llmswitch import-token grok-cli --file ~/.grok/auth.json (or stdin)
 */
async function cmdLoginTencent(id) {
  const ws = await import("@llmswitch/web-session");
  const byId = {
    "codebuddy-cn": { login: ws.loginCodeBuddyCn, label: "CodeBuddy CN (copilot.tencent.com)" },
    "codebuddy-intl": { login: ws.loginCodeBuddyIntl, label: "CodeBuddy International (codebuddy.ai)" },
    workbuddy: { login: ws.loginWorkBuddy, label: "WorkBuddy (workbuddy.ai)" },
  };
  const { login, label } = byId[id];
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: Tencent plugin-auth device flow impersonating the " + label + "\n" +
    "client. Tencent may change/block it. Use your own account.\n",
  );
  await login({
    onAuthUrl: (url) => {
      console.log("Open this URL in your browser and sign in:\n");
      console.log(`   ${url}\n`);
      console.log("Waiting for sign-in… (Ctrl+C to cancel)");
    },
  });
  console.log(`\nLogged in. Session saved. Route chats with model: ${id}:<model-id>`);
}

async function cmdLoginGrokCli() {
  const { loginWithGrokDevice } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: xAI device flow with the Grok CLI's public OAuth client\n" +
    "(reverse-engineered). Alternatively use: llmswitch import-token grok-cli --file ~/.grok/auth.json\n",
  );
  await loginWithGrokDevice({
    onUserCode: (dc) => {
      console.log("\n1) Open this URL in your browser:");
      console.log(`   ${dc.verificationUriComplete}`);
      console.log("2) Enter this code:");
      console.log(`   ${dc.userCode}\n`);
      console.log("Waiting for approval… (Ctrl+C to cancel)");
    },
  });
  console.log("\nLogged in. Session saved. Route chats with model: grok-cli:<model-id>");
}

async function cmdLoginOpenference() {
  const { loginOpenferenceWithLoopback } = await import("@llmswitch/web-session");
  console.log("\n⚠️  UNOFFICIAL FLOW: Openference PKCE loopback login (public client).\n");
  await loginOpenferenceWithLoopback({
    onAuthUrl: (url) => {
      console.log("Open this URL in your browser and sign in to Openference:\n");
      console.log(`   ${url}\n`);
      console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
    },
  });
  console.log("\nLogged in. Session saved. Route chats with model: openference:<model-id>");
}

async function cmdLoginGitlabDuo() {
  const { loginGitLabWithLoopback } = await import("@llmswitch/web-session");
  if (!(process.env.GITLAB_DUO_OAUTH_CLIENT_ID || process.env.GITLAB_OAUTH_CLIENT_ID)) {
    console.error(
      "gitlab-duo needs an operator-registered OAuth client id — register an OAuth app on\n" +
      "GitLab (scopes: ai_features read_user) and set GITLAB_DUO_OAUTH_CLIENT_ID first.",
    );
    process.exit(1);
  }
  await loginGitLabWithLoopback({
    onAuthUrl: (url) => {
      console.log("Open this URL in your browser and sign in to GitLab:\n");
      console.log(`   ${url}\n`);
      console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
    },
  });
  console.log("\nLogged in. Session saved. Route chats with model: gitlab-duo:<model-id>");
}

async function cmdLoginAgy() {
  const { loginAgyWithLoopback, loginAgyWithRefreshToken } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: `agy` signs in with YOUR Google account against Google's\n" +
    "internal Cloud Code API using the Antigravity client identity (same client as\n" +
    "`llmswitch login antigravity`). Reverse-engineered; Google may block/revoke it.\n",
  );
  const rt = flag("--refresh-token");
  let session;
  if (rt) {
    session = await loginAgyWithRefreshToken(rt);
  } else {
    session = await loginAgyWithLoopback({
      onAuthUrl: (url) => {
        console.log("Open this URL in your browser and sign in to Google:\n");
        console.log(`   ${url}\n`);
        console.log("Waiting for sign-in… (Ctrl+C to cancel, 5 min timeout)");
      },
    });
  }
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}. Session saved. Route chats with model: agy:<model-id>`);
}

/**
 * GitHub Copilot login — OAuth device flow (RFC 8628, public client, no
 * API key copy-paste needed), then the copilot_internal token exchange.
 *   llmswitch login copilot                            GitHub.com
 *   llmswitch login copilot --ghe https://ghe.example.com
 *   llmswitch login ghe-copilot --ghe https://ghe.example.com
 * After login, route via the gateway:  model "github:<model-id>" or
 * "ghe-copilot:<model-id>" (needs an active Copilot subscription).
 */
async function cmdLoginCopilot(kind) {
  const gheHost = flag("--ghe");
  const ghe = kind === "ghe" || Boolean(gheHost);
  const { loginWithDeviceFlow } = await import("@llmswitch/web-session");
  console.log(
    "\n⚠️  UNOFFICIAL FLOW: this signs in with YOUR GitHub account through the\n" +
    "@github/copilot CLI's public OAuth client (reverse-engineered). GitHub may\n" +
    "block/revoke it and it may violate ToS. Your account can be limited.\n" +
    "Continue only with your own account (a Copilot subscription is required).\n",
  );
  const session = await loginWithDeviceFlow({
    kind: ghe ? "ghe" : "github",
    gheHost: ghe ? gheHost : undefined,
    onCode: (userCode, uri) => {
      console.log("\n1) Open this URL in your browser:");
      console.log(`   ${uri}`);
      console.log("2) Enter this code:");
      console.log(`   ${userCode}\n`);
      console.log("Waiting for approval… (Ctrl+C to cancel)");
    },
  });
  console.log(`\nLogged in${session.email ? ` as ${session.email}` : ""}. Copilot token obtained.`);
  console.log(`Session saved. Now route chats with model: ${ghe ? "ghe-copilot" : "github"}:<model-id>`);
}

/** OAuth2 device-flow login (RFC 8628) — no API key copy-paste needed. */
async function cmdLogin() {
  const name = flag("--name") ?? process.argv[3] ?? "default";
  const preset = flag("--provider");
  // Antigravity: Google OAuth authorization-code flow (loopback redirect) +
  // Cloud Code project bootstrap. Unofficial, reverse-engineered flow.
  if (name === "antigravity" || preset === "antigravity") return cmdLoginAntigravity();
  // Claude / Codex: OAuth authorization-code + PKCE (loopback redirect).
  if (name === "claude" || preset === "claude") return cmdLoginClaude();
  if (name === "codex" || preset === "codex") return cmdLoginCodex();
  // GitHub Copilot cluster: device flow + copilot token exchange.
  if (name === "copilot" || preset === "copilot") return cmdLoginCopilot("github");
  if (name === "ghe-copilot" || preset === "ghe-copilot") return cmdLoginCopilot("ghe");
  if (name === "cursor") return cmdLoginCursor();
  if (name === "kiro") return cmdLoginKiro();
  if (name === "zed-hosted") return cmdLoginZedHosted();
  if (name === "clinepass") return cmdLoginClinepass();
  // P11-I OAuth cluster (see cmdLoginTencent & friends above).
  if (name === "codebuddy-cn" || name === "codebuddy-intl" || name === "workbuddy") return cmdLoginTencent(name);
  if (name === "grok-cli") return cmdLoginGrokCli();
  if (name === "openference") return cmdLoginOpenference();
  if (name === "gitlab-duo") return cmdLoginGitlabDuo();
  if (name === "agy") return cmdLoginAgy();
  const presets = {
    github: {
      deviceAuthUrl: "https://github.com/login/device/code",
      tokenUrl: "https://github.com/login/oauth/access_token",
    },
  };
  const deviceAuthUrl = flag("--device-url") ?? (preset && presets[preset]?.deviceAuthUrl);
  const tokenUrl = flag("--token-url") ?? (preset && presets[preset]?.tokenUrl);
  const clientId = flag("--client-id");
  const scope = flag("--scope");
  if (!deviceAuthUrl || !tokenUrl || !clientId) {
    console.error(
      "usage: llmswitch login [name] --provider github --client-id <id> [--scope <scopes>]\n" +
      "   or: llmswitch login [name] --device-url <url> --token-url <url> --client-id <id> [--scope <scopes>]\n" +
      "   or: llmswitch login antigravity [--refresh-token <rt>]  (Google OAuth, unofficial)\n" +
      "   or: llmswitch login claude|codex [--refresh-token <rt>]  (PKCE OAuth, unofficial)\n" +
      "   or: llmswitch login copilot [--ghe <host>]  (GitHub Copilot device flow, unofficial)\n" +
      "   or: llmswitch login cursor|kiro|zed-hosted|clinepass  (IDE OAuth providers, unofficial)\n" +
      "The client_id comes from your OAuth app registration at the provider.",
    );
    process.exit(1);
  }
  const { DeviceFlowClient, saveSession } = await import("@llmswitch/web-session");
  const client = new DeviceFlowClient({ deviceAuthUrl, tokenUrl, clientId, scope });
  const d = await client.start();
  console.log("\n1) Open this URL in your browser:");
  console.log(`   ${d.verification_uri_complete ?? d.verification_uri}`);
  console.log("2) Enter this code:");
  console.log(`   ${d.user_code}\n`);
  console.log("Waiting for approval… (Ctrl+C to cancel)");
  const t = await client.poll(d.device_code, { intervalSec: d.interval });
  const p = saveSession({
    name,
    kind: "oauth-device",
    provider: preset,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
  });
  console.log(`\nLogged in. Session saved to ${p}`);
}

async function cmdLogout() {
  const name = process.argv[3] ?? "default";
  const { deleteSession } = await import("@llmswitch/web-session");
  console.log(deleteSession(name) ? `Session "${name}" deleted.` : `No session named "${name}".`);
}

async function cmdSessions() {
  const { listSessions, loadSession } = await import("@llmswitch/web-session");
  const names = listSessions();
  if (names.length === 0) {
    console.log("No saved sessions. Run: llmswitch login --help");
    return;
  }
  for (const n of names) {
    const s = loadSession(n);
    const exp = s?.expiresAt ? (s.expiresAt > Date.now() ? "valid" : "expired") : "no expiry";
    console.log(`  • ${n} — ${s?.kind ?? "?"}${s?.provider ? ` (${s.provider})` : ""} — ${exp}`);
  }
}

/** Import browser cookies for a web-session pack (your own session, your own machine). */
async function cmdCookies() {
  const name = process.argv[3];
  const domain = flag("--domain");
  const file = flag("--file");
  if (!name || !domain) {
    console.error(
      "usage: llmswitch cookies <name> --domain <domain> [--file <netscape-cookies.txt>]\n" +
      "  --file: Netscape-format cookie export (from a browser extension).\n" +
      "  without --file: paste the raw Cookie header, then Ctrl+D.\n" +
      "WARNING: only use cookies from YOUR OWN browser session.",
    );
    process.exit(1);
  }
  const { CookieJar, saveSession, webchatCookieInfo } = await import("@llmswitch/web-session");
  // P11-J: for known web-chat providers, tell the user exactly which
  // cookies the site's driver needs before they paste anything.
  const info = webchatCookieInfo(name);
  if (info) {
    console.log(`Provider "${name}" needs cookies for: ${info.domains.join(", ")}`);
    console.log(`Hint: ${info.hint}`);
  }
  const jar = new CookieJar();
  if (file) {
    const { readFileSync } = await import("node:fs");
    jar.load(readFileSync(file, "utf8"), domain);
  } else {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    jar.load(chunks.join(""), domain);
  }
  if (jar.size() === 0) {
    console.error("no cookies parsed — check the format and try again.");
    process.exit(1);
  }
  // store the raw header so the session survives restarts
  const header = jar.headerFor(`https://${domain}/`);
  const p = saveSession({ name, kind: "cookies", cookies: header, cookieDomain: domain });
  console.log(`Saved ${jar.size()} cookie(s) for ${domain} → ${p}`);
}

/** One-shot chat through a cookie session (experimental web-session packs). */
async function cmdCookieChat() {
  const session = process.argv[3];
  // parse --flag value pairs; everything else is the prompt
  const rest = process.argv.slice(4);
  let url;
  let model = "auto";
  let format = "openai";
  const promptParts = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--url") url = rest[++i];
    else if (rest[i] === "--model") model = rest[++i];
    else if (rest[i] === "--format") format = rest[++i];
    else promptParts.push(rest[i]);
  }
  const prompt = promptParts.join(" ");
  const { CookieJar, CookieChatDriver, loadSession, isWebChatProvider, createWebChatDriver } = await import("@llmswitch/web-session");
  // P11-J: a session named after a web-chat provider (chatgpt-web,
  // claude-web, grok-web, …) drives that site's own protocol — no --url.
  const providerMode = isWebChatProvider(session);
  if (!session || !prompt || (!url && !providerMode)) {
    console.error(
      "usage: llmswitch cookie-chat <session> [--url <chat-endpoint>] [--model <m>] [--format openai|anthropic] \"prompt\"\n" +
      "  If <session> is a web-chat provider id (e.g. chatgpt-web), its built-in driver is used and --url is not needed.\n" +
      "EXPERIMENTAL — drives an unofficial web endpoint with your own cookies.",
    );
    process.exit(1);
  }
  const s = loadSession(session);
  if (!s || s.kind !== "cookies" || !s.cookies || !s.cookieDomain) {
    console.error(`session "${session}" not found or not a cookie session. Import with: llmswitch cookies`);
    process.exit(1);
  }
  const jar = new CookieJar();
  jar.load(s.cookies, s.cookieDomain);
  if (providerMode) {
    const driver = createWebChatDriver(session, jar);
    await driver.bootstrap();
    const reply = await driver.chat(model, [{ role: "user", content: prompt }]);
    console.log(reply);
    return;
  }
  const driver = new CookieChatDriver(jar, { url, wireFormat: format === "anthropic" ? "anthropic" : "openai" });
  const reply = await driver.chat(model, [{ role: "user", content: prompt }]);
  console.log(reply);
}

/** Multi-turn REPL: keeps history, routes each turn. /model <m> switches, /quit exits. */
async function cmdChatRepl() {
  const providers = await withLocal();
  if (providers.length === 0) {
    console.log("No providers connected. Set an API key env var (e.g. GROQ_API_KEY) and retry.");
    process.exit(1);
  }
  const { createInterface } = await import("node:readline");
  const router = createRouter(providers);
  let model = flag("--model") || "auto";
  const history = [];
  const system = flag("--system");
  if (system) history.push({ role: "system", content: system });
  console.log(`llmswitch repl — model=${model} (${providers.length} provider(s)). /model <m> to switch, /quit to exit.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  const showPrompt = () => { if (!rl.closed) rl.prompt(); };
  async function handleLine(raw) {
    const t = raw.trim();
    if (!t) return;
    if (t === "/quit" || t === "/exit") { rl.close(); return; }
    if (t === "/model" || t.startsWith("/model ")) {
      const m = t.slice(6).trim();
      if (m) { model = m; console.log(`model → ${model}`); }
      else console.log(`model = ${model}`);
      return;
    }
    if (t === "/clear") { history.length = 0; if (system) history.push({ role: "system", content: system }); console.log("history cleared"); return; }
    history.push({ role: "user", content: t });
    try {
      const r = await router.route({ model, messages: history });
      const text = r.response?.choices[0]?.message.content ?? "";
      console.log(`[${r.providerId}/${r.model}]`);
      console.log(text);
      history.push({ role: "assistant", content: text });
    } catch (err) {
      history.pop();
      console.log(`error: ${err.message?.slice(0, 200)}`);
    }
  }
  // event-based (not for-await): piped stdin closes the interface across awaits
  let chain = Promise.resolve();
  const finished = new Promise((res) => rl.on("close", res));
  rl.on("line", (line) => { chain = chain.then(() => handleLine(line)).then(showPrompt); });
  showPrompt();
  await finished;
  await chain;
  rl.close();
}

const SETUP_PORT_NOTE = "Point the tool at your gateway, then create a gateway API key (dashboard → Keys, or POST /api/keys).";

/** Coding-tool config wizard: prints the JSON snippet for the chosen tool. */
async function cmdSetup() {
  const config = loadConfig();
  const base = `http://localhost:${config.port}/v1`;
  const tools = {
    cursor: {
      label: "Cursor",
      where: "Cursor Settings → Models → set OpenAI API Key, enable “Override OpenAI Base URL”",
      snippet: { openaiApiKey: "YOUR_LLMSWITCH_API_KEY", openaiBaseUrl: base },
    },
    vscode: {
      label: "VS Code + Continue",
      where: "~/.continue/config.json → models[] (Continue extension)",
      snippet: { models: [{ title: "LLMSwitch", provider: "openai", model: "auto", apiKey: "YOUR_LLMSWITCH_API_KEY", apiBase: base }] },
    },
    cline: {
      label: "Cline (VS Code)",
      where: "Cline settings → API Provider = “OpenAI Compatible”",
      snippet: { apiProvider: "openai-compatible", baseUrl: base, apiKey: "YOUR_LLMSWITCH_API_KEY", modelId: "auto" },
    },
    continue: {
      label: "Continue",
      where: "~/.continue/config.json → models[]",
      snippet: { models: [{ title: "LLMSwitch", provider: "openai", model: "auto", apiKey: "YOUR_LLMSWITCH_API_KEY", apiBase: base }] },
    },
  };
  let name = flag("--tool");
  if (!name) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question(`Which coding tool? (${Object.keys(tools).join("/")}) `, res));
    rl.close();
    name = answer.trim().toLowerCase();
  }
  const t = tools[name];
  if (!t) {
    console.error(`unknown tool: ${name}. Choose one of: ${Object.keys(tools).join(", ")}`);
    process.exit(1);
  }
  console.log(`\n${t.label}\n  ${t.where}\n`);
  console.log(JSON.stringify(t.snippet, null, 2));
  console.log(`\n${SETUP_PORT_NOTE} (key names may vary slightly by extension version)`);
}

/** Latency benchmark: tiny prompt per provider, fastest first. */
async function cmdBench() {
  const providers = await withLocal();
  if (providers.length === 0) {
    console.log("No providers connected. Set an API key env var (e.g. GROQ_API_KEY) and retry.");
    process.exit(1);
  }
  const only = flag("--model");
  const runs = Math.max(1, parseInt(flag("--runs") || "1", 10));
  const list = only ? providers.filter((p) => `${p.id}:${p.defaultModel}` === only || p.id === only.split(":")[0]) : providers;
  if (list.length === 0) {
    console.error(`no provider matches --model ${only}`);
    process.exit(1);
  }
  const router = createRouter(providers);
  console.log(`Benchmarking ${list.length} provider(s), ${runs} run(s) each…`);
  const rows = [];
  for (const p of list) {
    let best = Infinity, ok = 0, lastErr = "";
    for (let i = 0; i < runs; i++) {
      const started = Date.now();
      try {
        await router.route(
          { model: `${p.id}:${p.defaultModel}`, messages: [{ role: "user", content: "Reply with: ok" }] },
          { timeoutMs: 30_000 },
        );
        best = Math.min(best, Date.now() - started);
        ok++;
      } catch (err) { lastErr = err.message?.slice(0, 80) ?? ""; }
    }
    rows.push({ id: p.id, model: p.defaultModel, ms: ok ? best : null, ok, runs, err: lastErr });
  }
  rows.sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
  for (const r of rows) {
    console.log(r.ms == null ? `  ❌ ${r.id}:${r.model} — failed (${r.err})` : `  ${r.ok === r.runs ? "✅" : "⚠️"} ${r.id}:${r.model} — ${r.ms}ms${r.runs > 1 ? ` (best of ${r.runs})` : ""}`);
  }
}

/** Quota table: probe each provider, read upstream rate-limit headers. */
async function cmdQuota() {
  const providers = await withLocal();
  if (providers.length === 0) {
    console.log("No providers connected. Set an API key env var (e.g. GROQ_API_KEY) and retry.");
    process.exit(1);
  }
  const router = createRouter(providers);
  console.log("Probing quota headers…");
  const rows = [];
  for (const p of providers) {
    try {
      const r = await router.route(
        { model: `${p.id}:${p.defaultModel}`, messages: [{ role: "user", content: "Reply with: ok" }] },
        { timeoutMs: 30_000 },
      );
      const q = r.quota;
      rows.push({
        id: p.id,
        remaining: q?.remaining ?? "n/a",
        limit: q?.limit ?? "n/a",
        reset: q?.resetAt ? new Date(q.resetAt).toLocaleTimeString() : "n/a",
        share: q && q.remaining != null && q.limit ? `${Math.round((q.remaining / q.limit) * 100)}%` : "n/a",
      });
    } catch (err) {
      rows.push({ id: p.id, remaining: "err", limit: "err", reset: "err", share: (err.message ?? "").slice(0, 40) });
    }
  }
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad("provider", 22)} ${pad("remaining", 12)} ${pad("limit", 10)} ${pad("reset", 12)} share`);
  for (const r of rows) {
    console.log(`  ${pad(r.id, 22)} ${pad(r.remaining, 12)} ${pad(r.limit, 10)} ${pad(r.reset, 12)} ${r.share}`);
  }
}

/** Cost report from the usage log. */
async function cmdCosts() {
  const { Store } = await import("@llmswitch/core");
  const config = loadConfig();
  const days = Math.max(1, parseInt(flag("--days") || "7", 10));
  const store = new Store(config.dataDir);
  try {
    const daily = store.dailySpend(days);
    const today = daily[daily.length - 1];
    const month = daily.reduce((s, d) => s + d.total, 0);
    const fc = store.forecastMonthly();
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const rows = store.usageSummary(midnight.getTime());
    const fmt = (n) => `$${n.toFixed(6)}`;
    console.log(`Today:       ${fmt(today.total)}`);
    console.log(`Last ${days}d:    ${fmt(month)}`);
    console.log(`Forecast/mo: ${fmt(fc.projectedMonthly)} (avg ${fmt(fc.dailyAvg)}/day)`);
    if (rows.length === 0) {
      console.log("\nNo usage recorded today yet.");
      return;
    }
    console.log("\nToday by provider/model:");
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`  ${pad("provider:model", 40)} ${pad("reqs", 8)} ${pad("tokens", 12)} errors`);
    for (const r of rows.slice(0, 20)) {
      const tokens = (r.promptTokens ?? 0) + (r.completionTokens ?? 0);
      console.log(`  ${pad(`${r.provider}:${r.model}`.slice(0, 40), 40)} ${pad(r.requests, 8)} ${pad(tokens, 12)} ${r.errors}`);
    }
  } finally {
    store.close();
  }
}

/** Shell completions for all commands. */
async function cmdCompletion() {
  const shell = (process.argv[3] || "bash").toLowerCase();
  const cmds = ["serve", "providers", "test", "keys", "compress", "chat", "models", "doctor", "mcp", "login", "logout", "sessions", "cookies", "cookie-chat", "import-token", "setup", "bench", "quota", "costs", "completion"];
  if (shell === "zsh") {
    console.log("#compdef llmswitch\n_llmswitch() {");
    console.log(`  local cmds=(${cmds.join(" ")})`);
    console.log("  _describe 'command' cmds\n}\ncompdef _llmswitch llmswitch");
    return;
  }
  if (shell !== "bash") {
    console.error("usage: llmswitch completion [bash|zsh]");
    process.exit(1);
  }
  console.log(`# llmswitch bash completion — source this file or drop in /etc/bash_completion.d/
_llmswitch() {
  local cur cmds
  cmds="${cmds.join(" ")}"
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ $COMP_CWORD -eq 1 ]; then
    COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
  fi
}
complete -F _llmswitch llmswitch`);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "providers") return cmdProviders();
  if (cmd === "test") return cmdTest();
  if (cmd === "keys") return cmdKeys();
  if (cmd === "compress") return cmdCompress();
  if (cmd === "chat") return cmdChat();
  if (cmd === "models") return cmdModels();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "mcp") {
    const { startMcp } = await import("@llmswitch/core");
    return startMcp();
  }
  if (cmd === "login") return cmdLogin();
  if (cmd === "logout") return cmdLogout();
  if (cmd === "sessions") return cmdSessions();
  if (cmd === "cookies") return cmdCookies();
  if (cmd === "cookie-chat") return cmdCookieChat();
  if (cmd === "import-token") return cmdImportToken();
  if (cmd === "setup") return cmdSetup();
  if (cmd === "bench") return cmdBench();
  if (cmd === "quota") return cmdQuota();
  if (cmd === "costs") return cmdCosts();
  if (cmd === "completion") return cmdCompletion();
  if (cmd && cmd !== "serve" && !cmd.startsWith("--")) {
    console.error(`unknown command: ${cmd}\nusage: llmswitch [serve|providers|test|keys|compress|chat|models|doctor|mcp|login|logout|sessions|cookies|cookie-chat|setup|bench|quota|costs|completion] [--port 6000] [--data-dir ./data]`);
    process.exit(1);
  }
  const port = flag("--port");
  if (port && !process.env.PORT) process.env.PORT = port;
  const dataDir = flag("--data-dir");
  if (dataDir && !process.env.DATA_DIR) process.env.DATA_DIR = dataDir;
  await start();
}

main().catch((err) => {
  console.error("fatal:", err?.message ?? err);
  process.exit(1);
});
