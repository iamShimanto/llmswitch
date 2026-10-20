# LLMSwitch — Remaining Work (2026-10-20)

> UPDATE 2026-10-20: sections A, B-long-term (i18n, combos, multi-account, ws, MITM, skills) COMPLETE. Only C (blocked on user) + 56 live-cred providers remain.

Honest, prioritized. "Buildable" = ami ekhoni korte pari. "Long-term" = prottekta ekta project.
"Blocked" = tomar input chara hobe na.

## A. Buildable now (P10+ candidates)

### A1. MCP tools — 6/17 done, 11 baki
Done: chat, list_providers, compress, pick_fastest_model, get_stats, web_search.
Baki (OmniRoute parity + useful):
1. `discover_models` — /v1/models/query via MCP
2. `estimate_cost` — prompt → cost estimate before sending
3. `explain_routing` — why this provider was picked
4. `check_quota` — quota status for a provider
5. `cache_stats` / `clear_cache` — prompt cache ops
6. `compress_preview` — compression without sending
7. `fetch_url` — web fetch via MCP
8. `rerank` — rerank documents
9. `create_embeddings` — embeddings via MCP
10. `budget_status` — budget/caps status
11. `replay_request` — inspector replay (needs A6)

### A2. CLI depth — 13/95 done
Done: serve, providers, test, keys, compress, chat, models, doctor, mcp, login, logout, sessions, cookies, cookie-chat (14 actually).
Baki (high value):
1. `chat` REPL mode (multi-turn, `--repl`)
2. `setup` wizard — coding-tool config generator (cursor/vscode/cline → point at localhost:6000)
3. `bench` — latency benchmark across providers
4. `quota` — quota dashboard in terminal
5. `costs` — cost report in terminal
6. `completion` — shell completions (bash/zsh)

### A3. Dashboard depth — 8 pages done
Done: Home, Providers, Keys, Playground, Inspector, Costs, Usage, Explain.
Baki:
1. Analytics page (charts: requests/day, cost/day, latency p50/p95)
2. Batch jobs UI
3. Quota/telemetry page
4. Sessions/packs page (web-session management UI)
5. Settings page (strategy, budgets, alerts config)

### A4. Translators — 2/91 done
Done: anthropic, gemini. Generic OpenAI passthrough covers most.
Baki (provider-specific dialects worth doing):
1. Codex (Responses API input/output)
2. Cursor (agent-style)
3. Kiro
4. Clova Studio (Naver)
5. Moonshot/Kimi quirks (forceStream)
6. GLM coding endpoint quirks

### A5. Semantic cache upgrade
Now: TF-IDF local, opt-in. Baki: real embeddings (provider-backed) + cosine similarity threshold config.

### A6. Inspector replay
Request inspector exists (ring buffer 200). Baki: "replay" button → re-send captured request, diff responses.

### A7. Missing API routes (32 groups, mostly low value)
Skip-worthy: Jina classify/segment, Vertex OCR, music/generations, vscode/* shims, relay/chat (404s upstream), media/[id].
Maybe worth: `/v1/batches` SSE stream, provider plugin manifest.

## B. Long-term (each a project)

1. **56 custom-transport providers** — bedrock (AWS SigV4), vertex (GCP auth), 16 cookie-session protocols, 17 OAuth device-flow providers, special-header ones. Needs live creds to verify each.
2. **Realtime websocket** `/v1/ws` — needs `ws` dep + provider realtime support.
3. **MITM proxy** — intercept/inspect/modify provider traffic (OmniRoute: 101 files).
4. **Skills system** — reusable prompt packs (OmniRoute: 104 files).
5. **i18n** — Bangla + other dashboard languages (OmniRoute: 144 files).
6. **Combo chains** — multi-model pipelines (OmniRoute-specific).
7. **Multi-account rotation** — session pool, account fallback, token refresh.

## C. Blocked — tomar input lage

1. **npm publish** — `NPM_TOKEN` + `npm login`. Then: `npm i -g llmswitch`.
2. **GitHub push** — org/user name bolo → repo create + push + release workflow.
3. **Web-session live verify** — chatgpt-web/claude-web/copilot-web/grok-web protocols need tor live logged-in session.
4. **Docker build test** — ei VM e Docker nai; tomar PC te `docker build` verify korte hobe.

## Suggested order
P10: A1 (MCP 11 tools) → A6 (replay, unlocks MCP replay) → A2 (CLI setup wizard + bench) → A3 (analytics page) → A4 (codex/cursor translators) → A5 → A7.
Then B1 (providers, needs live creds) or C (publish).
