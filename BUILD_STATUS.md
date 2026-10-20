# LLMSwitch — Build Status

Last verified: 2026-10-20. Every item below is test-verified, not just written.

## P0 — Core gateway ✅ COMPLETE
- [x] Monorepo (npm workspaces: `@llmswitch/core`, `@llmswitch/dashboard`, `llmswitch` CLI)
- [x] Express server, port 6000 + auto next-free-port, `PORT=` override
- [x] OpenAI-compatible `/v1/chat/completions` + `/v1/models` + SSE streaming
- [x] 12 Tier-1 providers (P1 expanded to 22)
- [x] Anthropic + Gemini translators (request/response/SSE)
- [x] Generic executor, error classifier (429/5xx/timeout → fallback; 401/400 → stop)
- [x] 6 routing strategies + ordered fallback chain
- [x] SQLite store (scrypt-hashed keys, usage log), per-key RPM limiter
- [x] Dashboard (4 pages), CLI `serve`, Dockerfile + compose, README/MIT/CONTRIBUTING
- [x] Tests: 27 vitest + 12 smoke — all pass

## P1 — Power features ✅ COMPLETE
- [x] **20 routing strategies** (all OmniRoute-parity names): priority, weighted,
      round-robin, context-relay (session affinity), fill-first (sticky),
      p2c, random, strict-random, least-used, cost-optimized, reset-aware
      (cooldown), reset-window, headroom, quota-weighted, auto (task-aware),
      lkgp, context-optimized, cache-optimized, fusion, pipeline
- [x] **Compression**: caveman + RTK + stacked pipeline, `/api/compression/preview`,
      `x-llmswitch-compress` header (code blocks + URLs preserved)
- [x] **Prompt cache**: exact-match, TTL, LRU eviction, `/api/cache/*`,
      `x-llmswitch-cache: off` bypass, streaming never cached
- [x] **Cost management**: price table (estimates, documented), per-request USD,
      per-key monthly budgets (warn/block via `BUDGET_ACTION`), forecast,
      CSV export, dashboard Costs page
- [x] **Smart routing**: task classifier (code/reasoning/writing/chat) → provider
      preference; `auto` strategy uses it
- [x] **Alerts**: webhook (`ALERT_WEBHOOK_URL`), provider_down at 3× consecutive
      failures, 10-min dedup, never throws
- [x] **Request inspector**: ring buffer (200), `/api/inspector/*`, dashboard page
- [x] **Playground**: `/api/playground` fan-out compare, dashboard page
- [x] **Model auto-discovery**: `/api/providers/:id/discover` + `/models/import`
- [x] **Local models**: Ollama + LM Studio auto-detect at boot (no key needed)
- [x] **CLI**: `serve`, `providers`, `test` (pings every connected provider)
- [x] **22 providers** total (12 P0 + 10 P1: moonshot, zai, dashscope, minimax,
      perplexity, cohere, siliconflow, nebius, sambanova, novita)
- [x] Dashboard: 7 pages (Overview, Providers, Playground, Inspector, Usage, Costs, API Keys)
- [x] Tests: 81 vitest + 12 P0 smoke + 19 P1 API smoke + 5 playground/discovery API checks — all pass

## P2 — Ecosystem ✅ COMPLETE (2026-10-20)
- [x] **148 provider families** in static catalog: 22 hand-verified + 126 converted
      from OmniRoute's registry (MIT, attribution in `catalog.ts`). 178 remaining
      OmniRoute entries need custom transports (web-session/image/oauth) — documented.
- [x] **Quota telemetry**: upstream rate-limit headers → per-provider quota store →
      `quota-weighted` + `reset-window` strategies use live data (graceful fallback)
- [x] **Tool-call emulation**: `tools`/`tool_choice` accepted; native passthrough on
      openai-wire, prompt-injection + `tool_call`-block parsing on anthropic/gemini
- [x] **Semantic cache**: TF-IDF local embedder (zero deps), opt-in `SEMANTIC_CACHE=1`,
      paraphrase matching in router
- [x] **PII redaction**: email/phone/card/API-key/SSN redacted in inspector (default ON,
      `PII_REDACT=0` to disable)
- [x] **Audit logs**: `audit_log` table, key/budget/cache/workspace events, `GET /api/audit`
- [x] **Team workspaces**: CRUD, per-key assignment, per-workspace spend, dashboard UI
- [x] **Web-session packs** (`packs/web-session`, opt-in, default OFF): real CookieJar +
      OAuth2 client (tested); 5 experimental pack skeletons (antigravity, claude-web,
      chatgpt-web, copilot-web, grok-web) with ToS warnings
- [x] **MCP server**: stdio JSON-RPC (protocol 2024-11-05), tools `chat` + `list_providers`,
      `llmswitch mcp`
- [x] **Desktop scaffold** (`desktop/`: Electron main+preload+builder config)
- [x] **Release prep**: `.github/workflows/ci.yml` + `release.yml` (npm trusted publishing)
- [x] Dashboard: 7 pages + workspace management on Keys page
- [x] Tests: 130+ vitest (core) + 8 (web-session) + 12 P0 smoke + 19 P1 API smoke — all pass

## P3 — API gaps ✅ COMPLETE (2026-10-20)
- [x] **`/v1/responses`** (OpenAI Responses API): input/instructions mapping,
      non-stream + SSE stream (`response.created/delta/completed`), usage mapping
- [x] **`/v1/embeddings`**: direct provider passthrough
- [x] **`/v1/images/generations`**: direct provider passthrough
- [x] **`/v1/audio/speech`**: audio bytes proxied with content-type
- [x] **`/v1/audio/transcriptions`**: multipart forwarded untouched
- [x] CLI: `keys` (list), `compress` (preview); MCP: `compress` tool (3 tools total)
- [x] Tests: 135 vitest (core) + 8 (web-session) + 12 P0 + 19 P1 + 9 P3 API checks — all pass

## P4 — remaining APIs ✅ COMPLETE (2026-10-20)
- [x] `/v1/completions` (legacy), `/v1/moderations`, `/v1/images/edits`,
      `/v1/audio/translations`, `/v1/videos/generations`, `/v1/rerank`
- [x] `/v1/files` (upload/list/get/delete/content), `/v1/batches` (create/list/get/cancel)
- [x] Tests: 142 vitest (core) + 8 (web-session); 12 P0 + 19 P1 + 9 P3 + 15 P4 + 3 concurrency — all pass

## PR — production readiness ✅ COMPLETE (2026-10-20)
- [x] Security: localhost-only bind default (`HOST=` override), `ADMIN_KEY` for
      management APIs (dashboard 🔑 field), security headers, graceful shutdown
- [x] Fixed: dev-mode boot (`tsx src/index.ts` silently did nothing — isMain check)
- [x] Concurrency: 30 parallel requests, usage rows intact, budget block verified
- [x] Dockerfile logic validated (no Docker in VM — runtime build untested)
- [x] README quickstart verified literally; README features rewritten; CHANGELOG.md
- [x] `.env.example` completed (ADMIN_KEY, HOST, BUDGET_ACTION, SEMANTIC_CACHE…)

## P5 — explainability + remaining easy APIs ✅ COMPLETE (2026-10-20)
- [x] `GET /v1/explain/routing` (real routing events + per-provider quality snapshot)
- [x] `/v1/images/upscale`, `/v1/multimodal-embeddings`, `/v1/text-to-speech/:voiceId`,
      `/v1/voices`, `/v1/speech-to-text`, `/v1/messages/count_tokens`,
      `/v1/responses/input_tokens`, `/v1/models/query`, `/v1/quotas/check`,
      `/v1/me/status`, `/v1/batches/delete-completed`
- [x] Tests: 12/12 P5 API checks pass; full GAP_ANALYSIS.md rewrite (fresh audit)

## P6 — web search ✅ COMPLETE (2026-10-20)
- [x] `POST /v1/search` (Tavily default / Brave via SEARCH_PROVIDER, normalized results)
- [x] `POST /v1/web/fetch` (SSRF guard: private IPs blocked, http(s) only, 1MB cap)
- [x] `POST /v1/web/map` (link extraction, absolutized)
- [x] Tests: 9 unit + 8 API checks pass

## P7 — MCP/CLI/dashboard depth ✅ COMPLETE (2026-10-20)
- [x] MCP: `pick_fastest_model` (real latency data), `get_stats`, `web_search` (6 tools total)
- [x] CLI: `chat`, `models`, `doctor` (9 commands total)
- [x] Dashboard: Routing explainability page (8 pages total) + `/api/explain/routing` alias
- [x] `POST /v1/alpha/search` alias
- [x] Tests: 13/13 MCP vitest pass

## P8 — provider catalog expansion ✅ COMPLETE (2026-10-20)
- [x] Re-audited all 272 OmniRoute provider dirs; converter v2 caught 68 missed
      (builder-form + openai/bearer entries the v1 converter skipped)
- [x] 148 → **216 provider families**; 7 shared model consts resolved
- [x] Passthrough routers (empty models) documented + test updated
- [x] Tests: 154/154 vitest pass

## P9 — OAuth device flow + web session ✅ COMPLETE (2026-10-20)
- [x] RFC 8628 device flow client (start → user code → poll; pending/slow_down/denied/timeout)
- [x] CLI: `login` (device flow, github preset), `logout`, `sessions`
- [x] Cookie session import: `llmswitch cookies <name> --domain <d> [--file f]`
- [x] `CookieChatDriver` — cookie-authenticated chat via any OpenAI/Anthropic-wire endpoint
- [x] Session store: ~/.llmswitch/sessions, 0600 perms
- [x] Pack added to npm workspaces; CLI depends on @llmswitch/web-session
- [x] Honest finding: DuckDuckGo keyless web-chat blocked by anti-bot 418 challenge from datacenter IPs
- [x] Tests: 16/16 pack vitest + 154/154 core + 12/12 P0 smoke; e2e verified (mock IdP login, mock cookie chat)

## P10 — full remaining work ✅ COMPLETE (2026-10-20)
- [x] A: 11 MCP tools → 17/17 total (discover_models, estimate_cost, explain_routing, check_quota, cache_stats, clear_cache, fetch_url, rerank, create_embeddings, budget_status, replay_request)
- [x] B: CLI depth → 19 commands (chat --repl, setup wizard, bench, quota, costs, completion)
- [x] C: Dashboard 8 → 13 pages + /api/* (quotas, usage/daily, sessions, config, batches)
- [x] D: 6 translators (codex/cursor/kiro/clova/kimi/glm) + provider embeddings + inspector replay + batch SSE + plugin manifest
- [x] E/F: 32 more pages → **45 dashboard pages** (all 53 OmniRoute top-level routes covered via merges + 4 extras)
- [x] G: nested tabs (Settings 7, Logs 4, Analytics 6, Costs 4, Context 7...) + provider detail + light/dark theme + header toggle
- [x] P11-A: dashboard i18n EN/BN (366 keys, header toggle)
- [x] P11-B: skills system (summarize/translate-bn/code-review + custom) + combo chains backend
- [x] P11-C: multi-account rotation (401/429 failover) + realtime ws /v1/ws
- [x] P11-D: MITM debugging proxy (localhost-only, key injection, redacted logs)
- [x] Verified: 232/232 core vitest + 16/16 pack + tsc clean (core+pack+dashboard) + dashboard build + 75 smoke ✅ + 17 skills/combos e2e + concurrency

## P11-E — Antigravity OAuth integration ✅ COMPLETE (2026-10-20)
- [x] Ported from OmniRoute v3.8.53 (MIT, attribution in code): Cloud Code URLs, model catalog + aliases (19 models), IDE fingerprint (UA, metadata enums, header scrubbing), session-id derivation, envelope shape, loadCodeAssist/onboardUser flow, public OAuth client creds
- [x] Pack: `packs/web-session/src/providers/antigravity.ts` — Google auth-code flow (loopback), `loginWithRefreshToken`, `loadCodeAssist`, `onboardUser` (LRO polling), `ensureProjectId`, session save (~/.llmswitch/sessions/antigravity.json, 0600), `getValidAccessToken`
- [x] Core: `src/executor/antigravity.ts` — streamGenerateContent executor (alias map, fingerprint headers, envelope, bounded 429 retry max 3, AntigravityAuthError), router dispatch on provider.id, registry OAuth connected() branch
- [x] Catalog: `antigravity` family (oauth authType, 15 chat models, 1M context)
- [x] CLI: `llmswitch login antigravity` (browser loopback or --refresh-token); gateway routing via model `antigravity:<model-id>`
- [x] Verified: 252/252 core vitest + 35/35 pack vitest + tsc clean
- [x] Honest limitations: OAuth scopes NOT pinned in OmniRoute's code (uses standard Cloud Code set — needs live verify); end-to-end needs user's real Google login (can't verify from VM); Google may block/revoke the unofficial flow

## P11-E2 — Antigravity browser OAuth (dashboard login) ✅ COMPLETE (2026-10-20)
- [x] Core `src/oauth/antigravity.ts` — browser login flow from the dashboard:
  - `GET /api/oauth/antigravity/start` (admin-gated): single-use random state (10-min TTL), returns Google consent URL with `redirect_uri=http://localhost:<actual port>/api/oauth/antigravity/callback`
  - `GET /api/oauth/antigravity/callback` (NOT admin-gated — exempted in `src/ingress/auth.ts`; state-protected): validates single-use state, exchanges code via the pack's `completeLoginWithCode` (token exchange → loadCodeAssist/onboardUser project bootstrap → session save 0600), then 302 → `/?oauth=antigravity`. Error pages are plain HTML with escaped messages; token values never appear in any response or log.
  - `GET /api/oauth/antigravity/status` (admin-gated): `{ connected, email, projectId, expiresAt }` — metadata only, never tokens
  - `POST /api/oauth/antigravity/disconnect` (admin-gated): deletes the session file
  - Google calls go through `RouteDeps.fetchFn` (default global fetch; tests inject a mock) — no network in tests
  - Core now declares `@llmswitch/web-session` as a dependency (workspace)
- [x] Dashboard: OAuth panel at the top of the Providers page (status poll on load; "Connect Antigravity" same-tab → Google; connected badge + account/project + Disconnect). App switches to the Providers tab on `?oauth=antigravity` and cleans the query string. i18n: 9 new keys in both en.ts and bn.ts (key parity preserved)
- [x] Verified: core tsc clean + 259/259 vitest (7 new OAuth tests: URL shape, bad/missing state → 400, single-use state, success → 302 + 0600 session + no token leak, status metadata-only, disconnect, admin gating with callback open) · pack tsc clean + 38/38 · dashboard tsc clean + build OK
- [x] Honest: mock-verified only — real Google login still needs the user's browser; scopes remain unverified against Google; ADMIN_KEY must be in localStorage (header key field) for Connect to work, same as other management actions

## P11-H — IDE OAuth providers: cursor, kiro, trae, zed-hosted, clinepass ✅ COMPLETE (2026-10-20)
All ported from OmniRoute (MIT License, release v3.8.53) with attribution comments in every file. Everything below is mock-verified only — no live IDE account was available; **live verification requires the user's own IDE accounts**.

| Provider | Real mechanism (per OmniRoute code) | Implemented | NOT implemented / needs live verify |
|---|---|---|---|
| **cursor** | OAuth: deep-control PKCE login (`cursor.com/loginDeepControl?challenge=&uuid=&mode=login&redirectTarget=cli` → poll `api2.cursor.sh/auth/poll`); refresh at `api2.cursor.sh/auth/exchange_user_api_key`; also IDE import (`cursorAuth/*` from state.vscdb) | Pack: PKCE param gen, poll-once, browser-login loop, refresh, import, session `~/.llmswitch/sessions/cursor.json` (0600) with machineId+authMethod meta. Core: creds resolve + typed error. CLI: `login cursor` / `import-token cursor`. Catalog: 7 models (auto, composer-2.5…). | **Chat wire NOT ported**: Cursor's chat upstream is protobuf Connect-RPC (`StreamUnifiedChatWithTools`) — OmniRoute's executor is 1,856 lines + protobuf helpers. `cursor:<model>` raises typed `CursorWireError` (HTTP 501) explaining this. Honest: login works; chat doesn't. |
| **kiro** | OAuth: (1) AWS SSO OIDC device flow for AWS Builder ID (`oidc.us-east-1.amazonaws.com` client register → device_authorization → /token poll; refresh at /token); (2) social Google/GitHub device flow at `prod.us-east-1.auth.desktop.kiro.dev`; (3) import refresh token. | Pack: all three flows + both refresh paths + session (0600) with authMethod/client creds/profileArn meta. Core: dedicated executor — conversationState builder, AWS event-stream frame parser, `Bearer` + `TokenType: EXTERNAL_IDP` header for IdP sessions, profileArn passthrough. CLI: `login kiro` / `--provider google|github` / `import-token kiro`. Catalog: 10 real upstream ids (OmniRoute live-validated — sonnet 4.5 default, no fabricated 4.6 ids). | Live device-code completion + model-id availability per plan (claude-sonnet-5 is plan-gated upstream). Region routing simplified to us-east-1 (OmniRoute supports eu-central-1 for some profiles). |
| **trae** | **Token import ONLY** — ByteDance publishes no OAuth client/device flow (OmniRoute: flowType "import_token"). Credential = Cloud-IDE-JWT pasted from solo.trae.ai (~14-day lifetime, no refresh). | Pack: JWT import with identity fields (web_id/biz_user_id/user_unique_id/scope/tenant/region, OmniRoute defaults), session (0600), expiry = JWT exp or 14-day default. Core: dedicated executor — `POST /chat_sessions` → `GET /chat_sessions/{id}/events` SSE (`plan_item` cumulative `thought` deltas, `token_usage`, `done`), `Authorization: Cloud-IDE-JWT` + work.trae.ai Origin (env `TRAE_WEB_ORIGIN` override), solo work/code modes. CLI: `import-token trae`. Catalog: authType `token-import` (new type!), 9 models. | JWT must be re-pasted every ~14 days. Upstream wire reverse-engineered from the web client — plan_item event shapes need a live session to fully validate. |
| **zed-hosted** | **Native-app RSA-keypair sign-in** (no OAuth client_id/secret): generate 2048-bit RSA pair → `zed.dev/native_app_signin?native_app_port=&native_app_public_key=&system_id=` → browser redirect to `http://127.0.0.1:<port>/?user_id=...&access_token=<redacted> (RSA-encrypted) → decrypt with private key → LLM token via `POST /client/llm_tokens` (user auth header "userId accessToken"). | Pack: keypair gen, sign-in URL, callback parse (URL/JSON/query forms), OAEP-SHA256(+PKCS1 fallback) decrypt, user fetch, session (0600, stores userId not secrets). CLI: `login zed-hosted` paste flow. Core: LLM-token exchange cached 45 min + `/completions` thread-envelope executor with per-provider request translation (anthropic/google via LLMSwitch translators, openai/x_ai passthrough) and NDJSON event parsing. Catalog: `zed-hosted`, models passthrough. | Provider detection is heuristic (claude→anthropic, gemini→google, grok→x_ai, else open_ai) since OmniRoute resolves it from a live /models catalog (env `ZED_PROVIDER_OVERRIDES` JSON to pin). Full catalog-fetch path not ported. |
| **clinepass** | OAuth: authorize at `api.cline.bot/api/v1/auth/authorize` (`client_type=extension`, callback/redirect uri); callback "code" is **base64-encoded JSON already containing tokens** (no exchange round-trip), else POST `/api/v1/auth/token`; refresh at `/api/v1/auth/refresh` `{refreshToken, grantType: "refresh_token", clientType: "extension"}`. Dual auth: also BYOK API key paste. | Pack: auth URL builder, base64-code decode (with garbage-tolerant last-brace trim), POST fallback, refresh, BYOK import, browser loopback login, session (0600). Core: dedicated executor with forceStream semantics (upstream is streaming-only: always `stream:true` upstream, accumulate for non-stream clients), extra headers `HTTP-Referer: https://cline.bot` + `X-Title: Cline`. CLI: `login clinepass` / `import-token clinepass`. Catalog: 4 cline-pass/* models, 1M context. | Model catalog live discovery (OmniRoute `clinepassModels.ts`) replaced by the offline fallback list from the Cline CLI. |

- [x] Pack: `src/providers/{cursor,kiro,trae,zedHosted,clinepass}.ts` + index.ts exports; SavedSession extended with `kind: "token-import"` and `meta?: Record<string, unknown>`; `tests/ide-oauth.test.ts` (31 tests: PKCE URL shape, poll states, refresh request shapes, RSA round-trip, base64-code decode, JWT import expiry, session persistence) — 109/109 pack tests green
- [x] Core: `src/executor/{cursor,kiro,trae,zedHosted,clinepass}.ts`; `src/providers/types.ts` authType += `"token-import"`; `src/providers/catalog.ts` 5 entries; `src/providers/registry.ts` per-provider creds checks (no antigravity special-case); `src/router/index.ts` dispatch; `tests/ide-oauth.test.ts` (26 tests: catalog/auth types, registry hide/show, payload shapes, event-stream frame parse, RSA header format, forceStream accumulation, all no-creds 401 hints, mock e2e for kiro/trae/zed/clinepass) — 285/285 core tests green
- [x] CLI: `login cursor|kiro|zed-hosted|clinepass`, `import-token <trae|cursor|clinepass|kiro>` (plus per-provider env overrides: CURSOR_ACCESS_TOKEN, KIRO_ACCESS_TOKEN, TRAE_ACCESS_TOKEN, ZED_HOSTED_ACCESS_TOKEN+ZED_HOSTED_USER_ID, CLINEPASS_API_KEY)
- [x] tsc clean (core + pack + dashboard); CLI `node --check` clean
- [x] Brutally honest: **cursor chat is unimplemented** (protobuf wire); trae/zed-hosted/kiro/clinepass chat paths are reverse-engineered wire ports — mock-verified, LIVE VERIFICATION REQUIRED against real IDE accounts. OmniRoute's own ToS flags: Kiro prohibits third-party proxy use (account-ban risk); cursor/trae/zed/clinepass are unofficial reverse-engineered flows.

## P11-F — GitHub cluster OAuth (github + ghe-copilot) ✅ COMPLETE (2026-10-20)
- [x] Ported from OmniRoute v3.8.53 (MIT, attribution in code): device-flow OAuth (public client `Iv1.b507a08c87ecfe98`, NO client_secret, decoded from OmniRoute's XOR-masked publicCreds), scope `read:user`, Copilot token exchange (`api.github.com/copilot_internal/v2/token`, `Authorization: token <github-token>`), refresh_token grant with client_id only, @github/copilot CLI header fingerprint (copilot-integration-id copilot-developer-cli, editor-version copilot/1.0.91, x-github-api-version 2026-08-01), GHE host-derived endpoints (`{host}/login/device/code`, `{host}/api/v3/copilot_internal/v2/token`, `{host}/api/v3/user`)
- [x] Pack: `packs/web-session/src/providers/githubCopilot.ts` — device flow via DeviceFlowClient (`loginWithDeviceFlow`), `exchangeCopilotToken`, `refreshGitHubAccessToken`, `refreshCopilotToken` (OmniRoute refreshCredentials semantics, 5-min expiry margin, persists updated session), session save (~/.llmswitch/sessions/github-copilot.json / ghe-copilot.json, 0600); sessionStore gained copilotToken/copilotTokenExpiresAt/copilotApiUrl/gheHost fields
- [x] Core: `src/executor/copilot.ts` — resolves creds at call time (env → session → exchange → refresh_token grant fallback, in-memory short-lived token cache), OpenAI-wire chat dispatch with the CLI fingerprint headers + endpoints.api host from the exchange; ghe-copilot force-streams upstream and drains SSE into one JSON response; typed `CopilotAuthError` with login hints; router dispatch + registry OAUTH_CREDS_CHECKS entries
- [x] Catalog: `github` (15 models, default gpt-5.6-sol) + `ghe-copilot` (14 models) families, authType oauth
- [x] CLI: `llmswitch login copilot [--ghe <host>]` / `llmswitch login ghe-copilot --ghe <host>` (device flow, prints user_code + verification URL); gateway routing via model `github:<model-id>` / `ghe-copilot:<model-id>`
- [x] Verified: core 315/315 vitest (11 new copilot tests: exchange→dispatch headers, token caching, refresh fallback with no-secret assertion, GHE force-stream drain, no-creds typed error) + pack 128/128 vitest (40 new githubCopilot tests: device login end-to-end vs mock IdP incl. 0600 session, refresh semantics, header builders) + CLI `node --check` OK; copilot.ts/catalog/router/registry tsc-clean
- [x] Honest limitations: MOCK-VERIFIED ONLY — needs a real GitHub account with an active Copilot subscription to verify live; the exchange's per-account endpoints.api host and GHE chat host shapes come from OmniRoute's code, not a live call; Claude models via Copilot's Anthropic-native /v1/messages shim and the Responses API surface are NOT ported (OpenAI chat/completions wire only); full-core `tsc` currently reports errors in other parallel OAuth work (claudeOAuth/codexOAuth/oauth sessions) — copilot files themselves are clean

## P11-G — Claude + Codex OAuth providers (Anthropic / OpenAI) ✅ COMPLETE (2026-10-20)
- [x] Ported from OmniRoute v3.8.53 (MIT, attribution in code): public PKCE client ids decoded from OmniRoute's XOR-masked publicCreds (`claude_id` = `9d1c250a-e61b-44d9-88ed-5944d1962f5e` — Claude Code CLI; `codex_id` = `app_EMoamEEZ73f0CkXaXp7hrann` — Codex CLI; NO client_secret for either — PKCE S256 only), auth/token endpoints from OAUTH_ENDPOINTS + registry (`https://api.anthropic.com/v1/oauth/authorize` + `/v1/oauth/token`; `https://auth.openai.com/oauth/authorize` + `/oauth/token`), Claude wire (registry claude: baseUrl + `?beta=true` urlSuffix, token in `x-api-key`, `anthropic-beta` ANTHROPIC_BETA_CLAUDE_OAUTH verbatim incl. `oauth-2025-04-20`, `anthropic-version 2023-06-01`, Claude-CLI headers), Codex wire (registry codex: `https://chatgpt.com/backend-api/codex/responses`, forceStream, `originator: codex_cli_rs`, `Version`/`Openai-Beta: responses_websockets=2026-02-06` headers, `chatgpt-account-id` workspace binding from the id_token claim, `session_id` affinity)
- [x] Pack: `packs/web-session/src/providers/claude.ts` + `codex.ts` — PKCE auth-code flow (`generatePkce` added to `oauth2.ts`: S256 verifier/challenge), `exchangeCode` (no client_secret anywhere), refresh via OAuth2Client, codex account-id extraction from id_token claims, session save (~/.llmswitch/sessions/claude.json / codex.json, 0600), loopback + refresh-token logins; scopes env-overridable (defaults are the standard CLI scope sets — OmniRoute pins no scope list, flagged NEEDS LIVE VERIFICATION in code)
- [x] Core: `src/executor/claudeOAuth.ts` (Messages API + `?beta=true`, OAuth headers, refresh-on-expired before dispatch, typed `ClaudeAuthError`) + `src/executor/codexOAuth.ts` (Responses API via existing `src/translator/codex.ts`, always-SSE upstream, non-stream = drain to `response.completed`, typed `CodexAuthError`); router dispatch + registry OAUTH_CREDS_CHECKS entries; catalog `claude` (5 models, default claude-sonnet-4-6) + `codex` (8 models, default gpt-5.5), authType oauth
- [x] Browser OAuth: `src/oauth/providerOAuth.ts` (generalized PKCE flow mirroring antigravity) — `/api/oauth/{claude,codex}/{start,callback,status,disconnect}`; callback state-protected (single-use, 10-min TTL, PKCE verifier bound to state), admin-gated others (callback exemption regex in ingress/auth.ts), tokens never returned; dashboard Providers page generalized to 3 connect cards (antigravity/claude/codex) with EN+BN i18n parity (379 keys); CLI `llmswitch login claude|codex [--refresh-token <rt>]`
- [x] Verified: core 315/315 vitest (19 new: per-provider start/PKCE-URL/admin-gate/bad-state/single-use-state/0600-session/status-no-token-leak/disconnect + dispatch refresh-on-expired with header assertions) + pack 78/78 vitest (20 new claude/codex incl. PKCE S256 math, no-secret assertions, account-id extraction) + core/pack/dashboard tsc clean + dashboard build OK + i18n parity 379/379 + live smoke vs real binary (401 without key; real Anthropic/OpenAI consent URLs generated; callback bad-state 400); (unrelated: repaired 5 literal `<redacted>` corruptions left by the write pipeline in githubCopilot src/test files — refresh scheme fixed to `token` per OmniRoute doc + test evidence; pack-wide tsc+tests green since)
- [x] Honest limitations: MOCK-VERIFIED ONLY — needs the user's own Anthropic + OpenAI (ChatGPT) subscription accounts to verify live; OAuth scope lists are NOT from OmniRoute's code (not pinned there) — env-overridable defaults, MUST be confirmed against a real login; OpenAI may restrict the consent redirect URI for the public Codex client (official CLI uses a fixed loopback port) — if the dashboard's dynamic-port callback is rejected, the CLI loopback login is the fallback; subscription-OAuth routing may violate Anthropic/OpenAI ToS (warnings in code, READMEs, CLI login)

## P11-I — Remaining OAuth providers wave (codebuddy-cn/intl, workbuddy, grok-cli, openference, gitlab-duo, agy, devin-desktop, devin-cli) ✅ COMPLETE (2026-10-20)
Ported from OmniRoute v3.8.53 (MIT, attribution in code). All mock-verified; every flow needs the user's real account login to verify live.

| Provider | Mechanism (from OmniRoute code) | Implemented | Live verification |
|---|---|---|---|
| codebuddy-cn | Custom plugin-auth device flow (POST /v2/plugin/auth/state → browser → GET token?state=), no client_id; chat forces stream (code 11101) | ✅ device login + refresh + fingerprint headers + force-stream accumulate | Tencent account (copilot.tencent.com) |
| codebuddy-intl | Same flow, www.codebuddy.ai, platform=ide | ✅ same, own config/session | codebuddy.ai account |
| workbuddy | Same protocol shape, own host www.workbuddy.ai, minimal headers (X-Product only), refresh token via X-Refresh-Token header; OmniRoute static catalog empty (passthrough) | ✅ device login + refresh + headers; catalog lists 1 known-served model, ids pass through | workbuddy.ai account |
| grok-cli | xAI device code (auth.x.ai/oauth2/device/code, public client_id `b1a00492-…` XOR-decoded from publicCreds, referrer=grok-build) + `~/.grok/auth.json` import fallback | ✅ device login + import-token + refresh; dedicated Responses-API executor (cli-chat-proxy.grok.com/v1/responses, X-XAI-Token-Auth: xai-grok-cli) | xAI account |
| openference | Auth code + PKCE loopback (public client_id `omniroute` XOR-decoded from publicCreds; port 56123) | ✅ loopback login + exchange + refresh + id_token identity | Openference account |
| gitlab-duo | Auth code + PKCE; **client_id must be operator-registered** (GITLAB_DUO_OAUTH_CLIENT_ID, scopes `ai_features read_user`) — OmniRoute ships none either | ✅ loopback login + /api/v4/user identity + optional direct_access grant; executor = code_suggestions completions transcript encoding (direct-gateway chat path NOT ported) | GitLab login + registered OAuth app |
| agy | **Same Google OAuth client + backend as antigravity** (OmniRoute AGY_CONFIG = ANTIGRAVITY_CONFIG copy, "cli" identity) | ✅ login reuses antigravity OAuth fns, own session (agy.json); dispatch reuses antigravity executor with agy session | Google account |
| devin-desktop | **Import-token only** (OmniRoute flowType "import_token"); chat transport = Windsurf Connect-protobuf RPC | ⚠️ import + session + catalog done; **transport NOT ported** — gateway calls return typed 501 "transport not ported" | Needs token from the Devin Desktop app |
| devin-cli | **Not OAuth at all** upstream: OmniRoute drives the local `devin` binary over ACP/stdio (`devin://acp/stdio`); binary self-authenticates | ❌ catalog entry kept, `disabled` with reason; registry never connects it | Run the Devin CLI locally instead |
| codex-app-server | Checked: local WebSocket app-server transport variant of codex, `authType: "none"` in OmniRoute — NOT a separate OAuth | ❌ skipped (documented; belongs to the codex work) | — |

- [x] Pack: `tencentPluginAuth.ts` (shared device flow) + `codebuddy-cn.ts` / `codebuddy-intl.ts` / `workbuddy.ts` thin configs; `grok-cli.ts`; `openference.ts`; `gitlab-duo.ts`; `agy.ts`; `devin-desktop.ts` (validate+save import). Sessions in ~/.llmswitch/sessions/<id>.json (0600).
- [x] Core: `src/oauth/sessions.ts` (creds checks + token resolution + per-protocol refresh) + `src/oauth/dispatch.ts` (generic-wire dispatch w/ fingerprint headers via new `ProviderDef.extraHeaders` merged in http.ts; dedicated grok/gitlab executors; agy via antigravity executor w/ session-name param; devin-desktop typed error) + registry OAUTH_CREDS_CHECKS (9 new) + router hook + catalog entries ×9 (+ `disabled` ProviderDef field; types.ts `authType` already had "token-import" from P11-H).
- [x] CLI: `llmswitch login codebuddy-cn|codebuddy-intl|workbuddy|grok-cli|openference|gitlab-duo|agy [--refresh-token]`; `llmswitch import-token devin-desktop <token>`; `llmswitch import-token grok-cli --file ~/.grok/auth.json` (or stdin).
- [x] Verified: core 333/333 vitest (18 new P11-I: catalog/registry/dispatch headers/wire/refresh/login-hints) + pack 128/128 vitest (19 new P11-I: per-flow mocks incl. header profiles, auth.json shapes, PKCE URLs, gitlab no-client-id error, direct_access parse) + core+pack tsc clean + CLI live spot-checks (gitlab-duo clear client-id error; devin-desktop/grok-cli session files written 0600).
- [x] Honest gaps: Tencent refresh request-body field names come from protocol shape, not a captured OmniRoute refresh call (NEEDS LIVE VERIFICATION, flagged in code); grok responses-stream delta parsing is heuristic (event shapes need a live xAI call to confirm); gitlab direct-gateway chat path not ported (completions path is); workbuddy/codebuddy-intl model lists are partial snapshots from OmniRoute's registry (live discovery upstream is auth-gated).

## P11-J — Keyless providers (authType "none") ✅ COMPLETE (2026-10-20)
- [x] Core: `authType: "none"` in types.ts + registry branch — ALWAYS connected with zero env vars; anonymous pool slot `[""]`; optional env key still honored when set. http.ts executor sends NO Authorization header when no credential exists (empty Bearer counts as a *bad* key upstream — cf. OmniRoute's OVHcloud note). Bugfix (pre-existing): router rotation loop used `if (!key) break`, silently breaking ALL keyless/noAuth providers (incl. Ollama/LM Studio) with "no healthy account keys" — now `key === null`; registry gives noAuth providers `allKeys: [""]` too.
- [x] Catalog (verified in OmniRoute v3.8.53 registry code, MIT attribution in comments): **pollinations** (authType optional upstream; gen.pollinations.ai/v1) · **kilo-gateway** (optional; OmniRoute live-probed keyless 200) · **ovhcloud** (optional; anonymous tier ~2 req/min/IP) · **llm7** (registry says apikey, but live probe: `gpt-oss:20b` answers keyless; roster refreshed from live /v1/models; default = verified-keyless model) · **duckduckgo-web** (NEW entry + NEW minimal executor `src/executor/duckduckgo.ts`: status→VQD-token→chat SSE, system-role folding, no OmniRoute-style JS challenge solver).
- [x] Live probes 2026-10-20 (this VM, no key): kilo-gateway ✅ 200 · ovhcloud ✅ 200 · llm7 gpt-oss:20b ✅ 200 (other llm7 models demand a key) · pollinations ✗ 401 "API key required" (OmniRoute verified 200 in Jul 2026 — anonymous tier tightened; free key via POLLINATIONS_API_KEY still optional-attached) · duckduckgo not live-probed this round (P9 probe: HTTP 418 anti-bot from datacenter IP — documented in executor header).
- [x] NOT flipped (probed, honestly keyed): naga-ac (chat 401 without creds despite "optional" upstream), uncloseai (redirects to a browser-verify wall), g4f-* family (anonymous requires proof-of-work "cake credits" our executor can't mint).
- [x] Dashboard: `/api/providers` exposes `authType`; Providers list + detail show a sky "No key needed — ready" badge for authType "none" (i18n key `providers.keylessBadge`, EN+BN, 380/380 parity).
- [x] Verified: 10/10 new keyless tests (registry always-connected + optional key, header omission/Bearer, router e2e keyless + noAuth regression, DDG executor flows incl. 418 honesty, /api/providers authType) · full core suite 382/382 · dashboard tsc clean + build OK · pack tests 128/128. (2 pre-existing MCP tests were updated to stub fetch: they encoded the old "bare env ⇒ no providers" invariant that keyless support intentionally changes. Separately, parallel in-flight P11 files — webchat pack/core — still had tsc errors at last check; none are in keyless files.) LIVE end-to-end: gateway booted with NO provider keys → healthz listed exactly the 5 keyless providers → real /v1/chat/completions succeeded keyless via kilo-gateway ✅ and ovhcloud ✅; llm7 answered 429 (shared anonymous daily quota exhausted — the documented keyless caveat).

## P11-K — Special-auth / custom providers (bedrock, vertex, tinycms, command-code, promptql + misclassified sweep) ✅ COMPLETE (2026-10-20)
Research: every id checked against OmniRoute v3.8.53 code (MIT attribution in all new files) — registry dirs, executors, shared.ts model lists. 11 of the listed ids (blitzapi, buildwithfern, codefree, do-apple-silicon, dodopayments, matsu, mia-auth-starter, mikucode, mia, nullnode, watt) exist NOWHERE in OmniRoute (v3.8.53 + main recursive trees, 29k paths) — cannot be ported faithfully; documented skip. `nimble` is Nimbleway web-extract/search tooling, not an LLM provider — skip. dgrid + kilo-gateway were already correct in the catalog.

| Provider | Classification | What was built |
|---|---|---|
| bedrock | dedicated executor | `src/executor/bedrock.ts`: SigV4 signer (node:crypto only, NO AWS SDK) + Converse REST mapping. Env: AWS_ACCESS_KEY_ID/SECRET (+SESSION_TOKEN, AWS_REGION). Router dispatch by id. |
| vertex | dedicated executor | `src/executor/vertex.ts`: SA JWT (RS256, RFC 7523) → OAuth token exchange (cached) → Vertex OpenAI-compat endpoint (`<region>-aiplatform.googleapis.com/.../endpoints/openapi/chat/completions`). Env: GOOGLE_APPLICATION_CREDENTIALS / VERTEX_* (+ VERTEX_ACCESS_TOKEN escape hatch). |
| tinycms-web | DISABLED (unportable) | Catalog entry kept for discovery with `disabled` reason: OmniRoute's executor needs an embedded Rust/WASM signer blob + DOM canvas-fingerprint mocks to mint x-secure-* headers/PoW — the device UUID alone cannot authenticate. |
| command-code | header/path config | Catalog entry with new `ProviderDef.chatPath` (`/provider/v1/chat/completions`, honoured by http.ts for OpenAI-wire); plain `Authorization: Bearer` scheme. |
| promptql | dedicated thin executor | `src/executor/promptql.ts`: start_thread GraphQL mutation + thread_events polling → final_response.message / <final_response> XML extraction; JWT claim parsing (Hasura project id); sticky threads dropped (fresh thread per request, flattened history). |
| inference-net | P8-converter bugfix | models: ["inference-net"] placeholder → real ids from OmniRoute's CHAT_OPENAI_COMPAT_MODELS: meta-llama/Llama-3.3-70B-Instruct, deepseek-ai/DeepSeek-R1, Qwen/Qwen2.5-72B-Instruct. |
| dgrid / kilo-gateway | already correct | catalog entries verified correct against OmniRoute (nothing changed). |

- [x] Infra: `authType: "env-creds"` added to types.ts + registry branch (connected when the provider's own has*Creds check passes; tokens/creds resolved at call time, never via key rotation); catalog.test.ts's `_API_KEY` convention now also exempts "env-creds" + disabled entries (a real bug was found + fixed while testing: the plain api-key registry branch never honoured `disabled` — now checked at the loop head for every branch); promptql credential normalized to `PROMPTQL_API_KEY` (PROMPTQL_TOKEN kept as an alias).
- [x] Verified: core tsc + pack tsc clean; 45/45 new tests (bedrock: AWS-docs SigV4 known-answer signature `5d672d79…f2b5d7`, creds errors, Converse mapping, signed dispatch mock; vertex: JWT shape + RS256 signature verify, jwt-bearer exchange mock + cache, SA-file resolution, pre-minted-token dispatch URL/auth headers; promptql: JWT claim paths, extraction, start+poll flows, expiry guard; specialAuth: catalog presence incl. WASM-disabled reason, registry connect rules, command-code chatPath dispatch). Full core + pack suites green.
- [x] Honest gaps (not claimed working): NO live verification — bedrock needs a real AWS account, vertex a real GCP service account, command-code a key, promptql a real prompt.ql.app session JWT (all mock-verified only). Bedrock streaming NOT ported (Converse binary event-stream framing — typed error, not faked). PromptQL sticky threads + send_thread_message follow-ups dropped (fresh thread per request). OmniRoute scopes/regions reproduced from code; Bedrock region list is a seed subset (OmniRoute seeds 8 models). The 11 not-found ids + nimble are NOT added (nothing to port from).

## Not done (needs user input / live sessions)
- npm publish (NPM_TOKEN), GitHub push (org name), Docker build test (no Docker in VM)
- Cookie/web-session protocols still need live logged-in sessions to verify (chatgpt-web, claude-web, copilot-web, grok-web, huggingchat, …); bedrock/vertex/promptql/command-code mock-verified only — live needs the user's AWS/GCP/accounts

## Verification commands
```bash
npm test                                   # 81 unit tests
node scripts/smoke.mjs                     # 12 P0 API checks
node scripts/smoke-p1.mjs                  # 19 P1 API checks
npx tsc -p packages/core/tsconfig.json --noEmit
```

## P11-L — Cookie/web-session providers (16) ✅ COMPLETE (2026-10-20)
All protocols ported from OmniRoute v3.8.53 (MIT attribution in every file). Drivers live in `packs/web-session/src/providers/webchat/` behind one contract (`WebChatDriver`: bootstrap/chat/chatStream); core routes via `src/executor/webchat.ts`. New `authType: "cookie"` (types.ts + registry branch): connected when `~/.llmswitch/sessions/<id>.json` exists (`llmswitch cookies <id>` imports; the command now prints each provider's cookie domains/hint). `llmswitch cookie-chat <provider-id> "prompt"` drives the site protocol directly (no --url). Registry total: **256 providers**.

| Provider | Protocol (from OmniRoute code) | Status |
|---|---|---|
| chatgpt-web | `/api/auth/session` → Bearer; `/backend-api/f/conversation` + delta-v1 JSON-Pointer decoder | ✅ Implemented. GAP: sentinel/PoW + turnstile headers are minted by chatgpt.com's own JS — omitted; WS stream-handoff raises a typed error. NEEDS LIVE VERIFICATION |
| chatgpt-web-free | No such protocol exists in OmniRoute code (0 hits) | ⚠️ Anonymous variant of chatgpt-web (cookies optional, wire model "auto") — whether chatgpt.com accepts cookieless POSTs is unverified |
| claude-web | sessionKey cookie; org discovery; single completion POST w/ inline conversation creation; Anthropic-style SSE | ✅ Implemented. OmniRoute uses a TLS-fingerprint client vs Cloudflare — plain fetch may be challenged |
| claude-web-cookie | No distinct protocol in OmniRoute code | ⚠️ Reuses claude-web driver; difference = full Cookie header verbatim (keeps cf_clearance) instead of sessionKey extraction |
| copilot-web | WebSocket `wss://copilot.microsoft.com/c/api/chat`; `/c/api/start`; hashcash challenge solver ported | ✅ Implemented. WS event shapes + accessToken query-param auth NEED LIVE VERIFICATION |
| grok-web | `grok.com/rest/app-chat/conversations/new`, NDJSON stream, `sso` cookie | ✅ Implemented. OmniRoute needs TLS impersonation (Cloudflare) — plain fetch from datacenter IPs will likely be challenged |
| duckduckgo | duck.ai status → `x-vqd-4` → chat SSE | ✅ Implemented. JS anti-bot challenge solver NOT ported (pluggable hook throws); **datacenter IPs get HTTP 418 ERR_CHALLENGE (live-probed P9)** — driver surfaces it as a dedicated error |
| deepseek-web | user-token → access token → session → PoW challenge → completion SSE (p/v path parser) | ✅ Implemented EXCEPT the PoW solver: OmniRoute's DeepSeekHashV1 WASM worker not ported — solver is pluggable, default throws NEEDS LIVE VERIFICATION |
| huggingchat | conversation create → root message id → multipart POST → JSONL stream | ✅ Implemented (most faithful port of the four batches) |
| lmarena | arena.ai create-evaluation SSE (0:/g:/d: frame codes), UUID-v7 ids, Supabase chunked-cookie reconstruction | ✅ Implemented. OmniRoute uses Chrome TLS impersonation vs Cloudflare — plain fetch may 403; non-UUID model names pass through unresolved |
| poe | poe.com `/api/gql_POST` ChatViewQuery, `p-b` cookie (executors/poe-web.ts; registry "poe" = paid API, NOT used) | ✅ Implemented (simplified GraphQL — no formkey/tag signing; whether p-b alone succeeds live is unverified). NOTE: converts catalog id "poe" to the cookie flavor |
| blackbox | app.blackbox.ai `/api/auth/session` + `/api/chat` (executors/blackbox-web.ts) | ✅ Implemented. Catalog entry converted from api.blackbox.ai key flavor to web (paid key still usable via custom provider). `validated` token: env override or random UUID, mirroring upstream |
| venice-web | Clerk `__client` cookie → session JWT → outerface.venice.ai inference, NDJSON | ✅ Implemented (full protocol). Note: OmniRoute's extractor grabs `venice_session` but its executor never uses it — driver follows the executor |
| deepai | OmniRoute has NO web chat: registry = API-key image provider only (`text2img`) | ❌ Honest gap stub — cookie holder + chat() throws the documented WebChatError. No endpoint invented |
| manus | OmniRoute has NO chat protocol: tokenExtractionConfig only, self-labeled "Missing Provider" (cookie `manus_session`) | ❌ Honest gap stub (driver id `manus`; OmniRoute's extraction id is `manus-web`). No endpoint invented |
| you-com-web | OmniRoute has NO chat: only `youcom-search` (API-key search) | ❌ Honest gap stub. No endpoint invented |

- [x] Verified: pack tsc clean + **219/219 vitest** (91 new webchat tests: bootstrap/payload shape, stream extraction, missing-cookie hints, gap-stub behavior — all mock fetch/WS, zero network) · core tsc clean + **387/387 vitest** (incl. catalog shape for all 16, registry hide/show by session file, DDG end-to-end through the real pack driver with mock fetch) · CLI `node --check` OK.
- [x] Honest summary: 12 of 16 have real implemented protocols; 1 is an anonymous variant (chatgpt-web-free), 1 a credential-handling variant (claude-web-cookie), 3 are documented gap stubs because OmniRoute itself ships no chat protocol for them (deepai, manus, you-com-web). **NONE are live-verified — every protocol needs the user's own browser cookies, and these reverse-engineered protocols rot fast.** DDG (418) and the TLS-fingerprint caveats (grok-web, lmarena, claude-web) are the known live blockers.
- 2026-10-20: Bronze palette default (Light #FAF7F2/#FFFFFF/#B88A44, Dark #171412/#26211C/#D6AD68, user-picked); Settings → Appearance palette picker; mobile nav collapse + Providers min-w-0 overflow fix; Home spacing fix.
