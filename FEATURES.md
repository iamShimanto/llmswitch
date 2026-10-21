# LLMSwitch — Full Feature List (v2 — complete)

> UPDATE 2026-10-20 (night): **OmniRoute-style router combos shipped.**
> A combo is now a named virtual model (dashboard → Combos): an ordered
> target list (provider:model refs, bare models, "auto", or other
> combos) with a strategy — priority, weighted, round-robin, random,
> least-used, cost-optimized, fill-first. Requests addressed to the
> combo name fall through targets on ANY failure until one answers;
> combos appear in /v1/models and work anywhere a model name goes.
> The old sequential pipeline combos remain (kind "pipeline"). The
> dashboard Combos page was rebuilt server-backed (it previously kept
> combos only in browser localStorage). A "free-pool" combo ships
> pre-made on the reference deployment.

> UPDATE 2026-10-20 (late evening): **OmniRoute-style Quotas page +
> per-provider default model.** The Quotas page now shows live remaining
> quota: rate-limit header telemetry for providers that advertise it
> (a wiring bug that kept it permanently empty is fixed), and for
> Antigravity a real per-account, per-model quota via Google Cloud
> Code's `retrieveUserQuota` (remaining % bar + reset time per bucket,
> 60s cached). Providers can also have their default model changed
> from the dashboard (provider page → model row → "Set default"),
> persisted across restarts.

> Open-source AI gateway (MIT). OmniRoute parity + new differentiators.
> Audit source: OmniRoute v3.8.53 tree — dashboard (~60 pages), `open-sse/services` (~300 modules),
> 272 provider families / 375 entries, ~296 executors, ~8k test files.
> Legend: `[P]` = OmniRoute parity · `[N]` = New (beyond OmniRoute) · Phases: `P0` MVP · `P1` v1 · `P2` later

> UPDATE 2026-10-20 (evening): **Multi-account + routing system shipped.**
> Every provider can carry multiple named accounts (dashboard → provider →
> Accounts): API keys, OAuth tokens, cookie sessions, browser-OAuth logins
> and Muse device logins can all be added as separate accounts. Requests
> rotate across accounts with a selectable strategy (round-robin /
> least-used / priority / random — Routing page or `account_strategy`
> config), per-account call/error stats are recorded, and usage/request
> logs carry the serving account id. **Routing rules** (Routing page) pin a
> model name or prefix (`gpt-*`) to an ordered provider chain with an
> optional ordering strategy; pinned `provider:model` requests and `auto`
> bypass rules.

---

## 1. Gateway Core API

| # | Feature | T | Ph |
|---|---------|---|----|
| 1.1 | OpenAI-compatible: `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models` | [P] | P0 |
| 1.2 | Responses API (`/v1/responses`) for coding agents (Claude Code / Codex style) | [P] | P1 |
| 1.3 | Anthropic Messages API ingress (`/v1/messages`) | [P] | P1 |
| 1.4 | Audio: `/v1/audio/speech` (TTS), `/v1/audio/transcriptions` (STT) | [P] | P1 |
| 1.5 | Images: `/v1/images/generations` routed to image providers | [P] | P1 |
| 1.6 | SSE streaming, per-provider stream normalization + stream recovery on break | [P] | P0 |
| 1.7 | Batch API (`/v1/batches`) — async batch jobs with status polling | [P] | P2 |
| 1.8 | Model discovery API (`/v1/models/query`) — search models by capability | [P] | P1 |
| 1.9 | Tokenized compatibility aliases (`/<client>/<key>/...`) for header-less clients | [P] | P1 |
| 1.10 | Headless serve mode (`serve --headless`, no dashboard) | [P] | P1 |

## 2. Provider System

| # | Feature | T | Ph |
|---|---------|---|----|
| 2.1 | **ALL 375 provider entries (272 families) ported from OmniRoute** — Tier 1 config-only (248) works with generic executor day one; Tier 2 custom-logic (24) + Tier 3 custom executors ported by priority. Full checklist: PROVIDERS.md | [P] | P0: Tier 1 → P1/P2: Tier 2/3 |
| 2.2 | One-file-per-provider adapter — new provider = one file, no core changes | [P] | P0 |
| 2.3 | Auth transports: API key, **OAuth 2.0 (PKCE + refresh)**, AWS SigV4 (Bedrock), GCP (Vertex), **cookie/session jar** | [P] | P0 |
| 2.4 | Multi-account per provider + rotation + per-account quota tracking | [P] | P0 |
| 2.5 | Model catalog per provider: capabilities (context, vision, tools, reasoning), pricing, deprecation lifecycle, endpoint policies | [P] | P0 |
| 2.6 | **Model auto-discovery**: pull model lists live from provider APIs | [N] | P1 |
| 2.7 | **Local providers first-class**: Ollama / LM Studio auto-detect, zero-config | [N] | P1 |
| 2.8 | Web-session provider packs (opt-in, default OFF): `antigravity`, `claude-web`, `chatgpt-web`, `copilot-web`, `grok-web` — cookie/OAuth session diye unofficial web backend use. ⚠️ ToS-risk: nijer account nijer risk e; jekono somoy bhangte pare. Core theke alada package, dashboard e warning banner soho. (Reference: OmniRoute MIT code, attribution soho reuse) | [P] | P2 |
| 2.9 | Media providers: image (Ideogram, Stability, Segmind…), video bridge, TTS (AWS Polly…) | [P] | P2 |
| 2.10 | Web-search providers + fallback chain + search cache | [P] | P2 |
| 2.11 | **Keyless providers** (`authType: "none"`): always connected, no key needed, no Authorization header sent — `pollinations`, `kilo-gateway`, `ovhcloud`, `llm7` (subset), `duckduckgo-web` (minimal VQD-session executor; 418 anti-bot risk documented). Optional user key honored when set (higher limits). | [P] | P11 |

## 3. Format Translation Layer

| # | Feature | T | Ph |
|---|---------|---|----|
| 3.1 | Translators: OpenAI ↔ Anthropic ↔ Gemini ↔ 20+ wire formats | [P] | P0 |
| 3.2 | Tool/function-call translation + emulation for providers without native support | [P] | P1 |
| 3.3 | Reasoning effort mapping (low/medium/high), thinking-budget controls, thought-signature stores | [P] | P1 |
| 3.4 | Modality bridge: vision/audio/video inputs routed across capable models | [P] | P1 |
| 3.5 | Structured output / JSON-mode enforcement across providers | [N] | P1 |
| 3.6 | Translator debug view in dashboard | [P] | P1 |

## 4. Routing & Combos

| # | Feature | T | Ph |
|---|---------|---|----|
| 4.1 | 20 routing strategies (priority, weighted, round-robin, cost-optimized, quota-weighted, least-used, latency, reset-aware, headroom, p2c, context-optimized, cache-optimized, fusion, pipeline…) | [P] | P0: 6 core → P1: all |
| 4.2 | Auto strategies (rules/score/cost/eco/latency/fast/sla-aware…) + account-fallback strategies | [P] | P1 |
| 4.3 | Combos: virtual providers merging multiple backends (auto-combo, image/speech/video combos) | [P] | P1 |
| 4.4 | **Smart task-based routing**: classify (code/writing/reasoning/vision) → best model class | [N] | P1 |
| 4.5 | **Fan-out mode**: one prompt → N models in parallel → judge/voting picks best | [N] | P2 |
| 4.6 | Model aliases (`code-best`, `cheap-fast`) resolved by routing rules | [N] | P1 |

## 5. Fallback, Resilience & Quota

| # | Feature | T | Ph |
|---|---------|---|----|
| 5.1 | Error classifier (429/5xx/timeout/auth/model-denied) → per-class fallback behavior | [P] | P0 |
| 5.2 | Circuit breaker per provider/account, cooldown + exponential backoff, Retry-After respect | [P] | P0 |
| 5.3 | Per-provider quota fetchers + live quota telemetry + reset-aware scheduling | [P] | P1 |
| 5.4 | Rate-limit manager: rolling RPM, sliding window, per-key + per-account gates | [P] | P0 |
| 5.5 | Emergency fallback chain when everything degrades | [P] | P0 |
| 5.6 | **Rescue queue**: all-down → queue requests, auto-replay on recovery | [N] | P2 |
| 5.7 | Request dedup (identical in-flight requests share one upstream call) | [P] | P1 |
| 5.8 | Free-tier budget tracker: pool-deduped aggregation across providers | [P] | P1 |

## 6. Compression & Token Optimization

| # | Feature | T | Ph |
|---|---------|---|----|
| 6.1 | Caveman-style compressor: strip pleasantries/hedging/filler, preserve code, per-language rules | [P] | P1 |
| 6.2 | RTK-style structural compressor: dedupe + reference-ify repeated content | [P] | P1 |
| 6.3 | Stacked pipeline with before/after token report + preview API | [P] | P1 |
| 6.4 | Compression quality-loss eval harness | [P] | P2 |
| 6.5 | **Prompt auto-optimizer**: rewrite verbose prompts for cheaper models (A/B scored) | [N] | P2 |

## 7. Caching

| # | Feature | T | Ph |
|---|---------|---|----|
| 7.1 | Exact-match prompt cache (memory/SQLite, TTL) + stats page | [P] | P1 |
| 7.2 | Reasoning/thinking cache + signature cache | [P] | P1 |
| 7.3 | Provider-native prompt-caching passthrough (Anthropic/OpenAI cache headers) | [P] | P1 |
| 7.4 | **Semantic cache**: embedding-similarity hits for reworded prompts | [N] | P2 |

## 8. Dashboard (all pages)

| # | Feature | T | Ph |
|---|---------|---|----|
| 8.1 | Home/overview + first-run onboarding + readiness checklist | [P] | P0 |
| 8.2 | Providers, provider stats, media providers, free-provider rankings | [P] | P0 |
| 8.3 | Models, model discovery, free-tiers budget page, Radar (opt-in free catalog) | [P] | P1 |
| 8.4 | Combos + auto-combo config | [P] | P1 |
| 8.5 | **Playground**: side-by-side multi-provider compare (output/cost/latency) | [N] | P1 |
| 8.6 | **Request inspector + replay**: full translated payloads, re-run on another model | [N] | P1 |
| 8.7 | Context/compression lab + translator view | [P] | P1 |
| 8.8 | Usage, costs, quota, limits, tokens analytics | [P] | P0 |
| 8.9 | Logs, log export, audit log, activity feed, conversation history | [P] | P1 |
| 8.10 | Health, resilience, chaos engineering panel, runtime, system | [P] | P1 |
| 8.11 | Cache manager, memory, batch jobs | [P] | P1 |
| 8.12 | API endpoints + API key manager | [P] | P0 |
| 8.13 | MCP, A2A, agent skills, ACP agents, orchestration/conductor, CLI agents, cloud agents | [P] | P2 |
| 8.14 | Plugins, skills, search tools, webhooks | [P] | P2 |
| 8.15 | Settings, profile, gamification, leaderboard, changelog/news | [P] | P2 |

## 9. Coding-Agent Integration

| # | Feature | T | Ph |
|---|---------|---|----|
| 9.1 | CLI-tools settings manager: generate/manage configs for Claude Code, Cline, Codex, Crush… | [P] | P2 |
| 9.2 | MITM mode: route coding CLIs through gateway transparently | [P] | P2 |
| 9.3 | OpenCode provider + plugin packages | [P] | P2 |

## 10. Agents, MCP & Orchestration

| # | Feature | T | Ph |
|---|---------|---|----|
| 10.1 | MCP server (gateway as MCP tools) + A2A task support | [P] | P2 |
| 10.2 | Agent skills: generate / coverage / route | [P] | P2 |
| 10.3 | Orchestration: conductor, workflow FSM, agentic pipeline | [P] | P2 |

## 11. Cost Management [N]

| # | Feature | T | Ph |
|---|---------|---|----|
| 11.1 | Real-time spend per project / key / member | [N] | P1 |
| 11.2 | Hard budget caps: auto-reject or auto-downgrade on cap hit | [N] | P1 |
| 11.3 | Usage forecasting ("$10 lasts ~12 days at current pace") | [N] | P2 |
| 11.4 | Cheapest-capable auto-mode at a quality floor | [N] | P2 |
| 11.5 | Monthly reports + CSV export | [N] | P1 |

## 12. Team & Access

| # | Feature | T | Ph |
|---|---------|---|----|
| 12.1 | API keys: issue/revoke, per-key rate limits, no-log mode | [P] | P0 |
| 12.2 | **Workspaces**: members, roles, per-member quotas, shared configs | [N] | P2 |
| 12.3 | Per-project routing/budget configs | [N] | P1 |

## 13. Security & Compliance [N]

| # | Feature | T | Ph |
|---|---------|---|----|
| 13.1 | PII redaction in stored logs (emails, phones, keys auto-masked) | [N] | P1 |
| 13.2 | Secrets encrypted at rest, never in logs; env/file based, no secrets in repo | [P] | P0 |
| 13.3 | IP filtering, admin concurrency controls | [P] | P1 |

## 14. Developer Experience

| # | Feature | T | Ph |
|---|---------|---|----|
| 14.1 | CLI: `serve`, `providers list`, `test <provider>`, config validate | [P] | P1 |
| 14.2 | TypeScript + Python SDKs | [N] | P2 |
| 14.3 | Examples folder (free-tier stack, team, local-only configs) | [P] | P1 |
| 14.4 | Docs with i18n (staged; EN first) | [P] | P2 |

## 15. Distribution & Platform

| # | Feature | T | Ph |
|---|---------|---|----|
| 15.1 | npm global (`npx llmswitch`), Docker image, docker-compose variants | [P] | P0 |
| 15.2 | Clone-and-run from source, local SQLite DB, first-run onboarding | [P] | P0 |
| 15.3 | Desktop app (Electron), PWA mobile dashboard | [P] | P2 |
| 15.4 | Release channels (stable / LTS) + semantic versioning + changelog | [P] | P1 |

## 16. Open Source & Community

| # | Feature | T | Ph |
|---|---------|---|----|
| 16.1 | MIT license | [N] | P0 |
| 16.2 | README, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, issue/PR templates | [N] | P0 |
| 16.3 | CI secret scanning, `good first issue` labels | [N] | P1 |
| 16.4 | Auto-generated changelog + GitHub releases | [N] | P1 |

## 17. Quality & Ops

| # | Feature | T | Ph |
|---|---------|---|----|
| 17.1 | CI: lint → typecheck → unit/integration tests → docker build | [P] | P0 |
| 17.2 | Routing + compression eval harnesses | [P] | P2 |
| 17.3 | Chaos engineering: fault-injection panel to test resilience | [P] | P2 |
| 17.4 | Docs-vs-code count gates (numbers in docs must match computed values) | [P] | P1 |
| 17.5 | Health prober: synthetic checks, auto-disable sick providers | [P] | P1 |
| 17.6 | Config hot-reload, backup/restore, proxy-pool visibility | [P] | P1 |
| 17.7 | **Webhooks & alerts**: provider down, quota low, budget hit → Discord/Telegram/email | [N] | P1 |

---

## Build order

- **P0 MVP (~2–3 wks):** 1.1, 1.6, 1.10, 2.1 (15–20), 2.2–2.5, 3.1 (6 core), 4.1 (6 core), 5.1, 5.2, 5.4, 5.5, 8.1, 8.2, 8.8, 8.12, 12.1, 13.2, 15.1, 15.2, 16.1, 16.2, 17.1
- **P1 (~1–2 mo):** dashboard depth, translation, compression, caching, cost mgmt, playground, inspector, webhooks, CLI, combos, quota telemetry
- **P2 (later):** agents/MCP, fan-out, semantic cache, media, batch API, desktop/PWA, chaos, web-session providers

---

## Update 2026-10-20 (evening) — Combos v2: OmniRoute depth

Verified against the user's own OmniRoute screenshots. Router combos now
match OmniRoute's combo system:

- **Per-target account pinning** — each target can pin a specific account
  (key or session) or stay dynamic; PROVIDERS show their account counts
  in the builder.
- **Target syntax** — OmniRoute-style `provider/model` refs alongside
  `provider:model`; combo names may carry a namespace slash
  (`team/main`); `auto/` is reserved.
- **Combo config** — system-prompt override; response validation
  (forbidden/required substrings, min length) that fails over to the next
  target on a bad 200; advertised context length in `/v1/models`;
  enable/disable toggle.
- **Strategies 7 → 11** — added p2c, headroom (quota-aware), context-relay
  (sticky last winner), strict-random.
- **Built-in auto/* catalog** — the 17 advertised templates
  (`auto/best-coding`, `best-reasoning`, `best-fast`, `best-vision`,
  `best-chat`, `best-free`, pro-*, coding/fast/chat/cheap/smart/
  subscription) resolve live from connected providers with weighted
  scoring + template system prompts; listed in `/v1/models` and the
  dashboard catalog section with live candidate counts.
- **Test-all endpoint** — POST /api/combos/test probes every target and
  returns per-target results + `resolvedBy` (OmniRoute's test modal).
- **Dashboard** — 4-stage wizard builder (Basics → Steps → Strategy →
  Review with checklist + summary grid), steps with provider → model →
  account pickers and combo refs, strategy tiles + advanced settings,
  rich combo cards (copy id, strategy badge, target chips with account
  labels, Active toggle, per-target test results, Edit/Delete).

Verified: core 435/435; local E2E (slash combo + config round-trip,
test-all fall-through, 17 templates, auto/best-chat live answer,
query-delete); domain live: auto-catalog serving, free-pool test-all
4/4 with resolvedBy, `auto/best-fast` answered "V2-OK" via kilo.

---

## Update 2026-10-20 (night) — Provider pages v2 (OmniRoute parity)

Verified against the user's OmniRoute provider screenshots:

- **Directory** — providers grouped into category sections (API Key /
  OAuth / Web Cookie / Free-Keyless) with connected/total counts and a
  per-section **Test All**; stat chips (Total + per-category, click to
  filter); **two searches** (providers, and search-by-model with a 🎯
  match hint on cards); **Configured-only** and **Compact** toggles;
  media kind chips (Image/Video/Music/TTS/STT/Embedding, derived from
  model ids); cards show **"● N Connected"** (default + accounts) or
  "No connections", plus an **enable/disable switch** (off providers
  leave rotation but stay connected).
- **Detail** — header shows the live connection count; **per-provider
  account-strategy override** card; Accounts get search + All/Active/
  Error filters.
- **Models** — filter search, Visible/Hidden filters, **eye toggles**
  (hidden models leave routing but stay listed), Show/Hide all,
  "N/M active" count, humanized display names, BUILT-IN/CUSTOM badges,
  copy-id buttons; Test-all skips hidden models.
- **Custom Models** — add model ids with optional display names; they
  union into routing like discovered models and persist in the store.
- **Param Filters** — per-provider blocked-parameter list; the generic
  executor strips those keys from outgoing payloads (e.g. NVIDIA NIM
  rejecting `thinking`).
- **Cookie guide** — OmniRoute-style "How to get the session credential"
  card (fast Cookie-Editor path + manual DevTools path + password
  warning) on cookie provider connect forms.

Verified: core 437/437 + pack 222/222; local E2E (custom model round
trip, hide → excluded from /v1/models but listed in catalog, param
block + strategy persistence, disable → provider leaves /v1/models,
re-enable restores); domain catalog serves the new fields.

---

## Update 2026-10-20 (night) — Costs v2 + persistent provider stats

- **Pricing engine v2**: model-name pattern pricing (45+ families) so
  subscription/aggregator-routed models (Antigravity Claude/Gemini,
  NVIDIA-hosted open models, Muse Spark) get list-price estimates;
  free routes (keyless providers, *:free models) resolve as priced-/bin/bash;
  user price overrides from the dashboard Pricing tab beat everything.
- **History backfill**: zero-cost usage rows logged before a price
  existed are repriced once at boot.
- **Persistent stats**: provider Calls/Errors/Latency now aggregate the
  usage database — deploys and restarts no longer reset them.
- **Costs page**: priced-coverage indicator, spend-by-provider table,
  editable budgets (global cap + warn/block, per-key budgets with
  month-to-date spend), live pricing table with override management,
  database-backed Quota Share.
- Providers directory no longer shows the OAuth connect panel at the
  top (the cards live on each provider's detail page).

## Cache v2 (2026-10-20)
The v1 prompt cache was audited and rebuilt. Weaknesses found: in-memory
only (every deploy wiped it AND its stats); the key missed top_p, stop,
seed, penalties, response_format and user (a request could be served a
response generated with different parameters); one shared namespace for
all gateway keys; FIFO instead of LRU eviction; responses stored by
reference (caller mutation could corrupt them); streaming requests never
cached; the semantic cache matched across ANY provider/model/system
prompt/caller with no expiry; the dashboard hit-rate display multiplied
by 100 twice.
- Exact cache v2 (`cache/index.ts`): full-parameter keys via sorted
  stable stringify; per-API-key namespace (`RouteOptions.cacheNamespace`,
  wired at the chat/responses/messages handlers); true LRU; values
  cloned in and out; optional write-through SQLite persister
  (`prompt_cache` table in store/db.ts) — entries survive restarts and
  deploys; TTL/max configurable via CACHE_TTL_MS / CACHE_MAX_ENTRIES
  (default 1h / 2000).
- Streaming (`cache/stream.ts`): completed streams are tapped, assembled
  (content + tool calls + usage) and stored; a later streaming hit
  replays the stored response as protocol-valid chunks. Broken streams
  store nothing.
- Semantic cache v2: entries scoped to namespace + provider + model +
  system-prompt hash, TTL-bound, cloned, with hit/miss stats.
- `GET /api/cache/stats` → `{ exact, semantic }`; DELETE clears both.
  Dashboard Cache page shows persistence state, TTL/max and semantic
  stats; the hit-rate bug is fixed.
- Tests: cache-v2.test.ts ×14 (key sensitivity, namespace isolation,
  LRU, cloning, persister round-trip + expiry, semantic scoping + TTL,
  stream assembly/broken-stream/replay); the old "streaming is never
  cached" test now asserts the v2 behaviour. Core 459/459.
- Domain proof: identical non-stream call #2 returned `cached: true`;
  streaming call #2 logged cached=true at 0 ms; after
  `docker compose restart` the stats still showed entries=2 (hydrated
  from SQLite) with persistent: true.

## Rotation v2 — per-model circuit breaker (2026-10-20)
Audit found the real time sink: 404 was classified "bad_request", which
STOPPED the provider chain (no fall-through) and recorded NO cooldown —
a dead model cost a full upstream round-trip on every request, forever,
and one less error would not have helped. Account rotation also ignored
model errors entirely.
- `router/errors.ts`: 404/410 are now `model_error` — chains fall
  through to the next provider; 400/422 still stop the chain.
- `router/breaker.ts` (ModelBreaker): per-(provider, model) failures
  with thresholds and escalating blackouts — model_error 10 min ×3
  (cap 6h; 410 Gone opens on the FIRST failure), rate_limited 60s,
  server_error/timeout 30s ×2 (cap 5 min). Open pairs are skipped
  instantly; pinned requests fail fast with the reason + retry time.
  After the cooldown exactly one half-open probe runs; success clears,
  failure re-opens escalated. Auth/bad-request outcomes never trip it.
- Account rotation tries ONE extra account on a model error (a model
  may be entitled on another account, e.g. Antigravity) instead of the
  whole roster.
- Visibility: `GET /api/circuit-breakers`, `POST
  /api/circuit-breakers/reset` (per pair or all), Routing page section
  with per-pair Reset. The provider-wide 30s cooldown for 429/5xx is
  unchanged and model errors no longer cool the whole provider.
- Tests: breaker.test.ts ×9 — classifier split, thresholds, 410
  instant-open, half-open single probe, escalation, router fall-through
  + fail-fast fetch counting, 400 chain-stop preserved. Core 468/468.
- Domain proof (NVIDIA's retired meta/llama-3.3-70b-instruct, upstream
  410): call 1 hit upstream and opened the breaker (failures=1, retry
  in ~10 min); calls 2–3 were stopped at the gate — the breaker still
  showed failures=1 afterwards, i.e. no further upstream calls happened.
  Breakers were reset and the throwaway key deleted after the test.

## Hardening & completeness batch (2026-10-20, evening)
Seven improvements shipped one by one, each tested and verified live:
1. **Security**: login failure lockout (5 consecutive failures → 5 min
   lock, doubling to 1 h, audited; the old 10/min throttle remains),
   X-Frame-Options tightened SAMEORIGIN → DENY, minimum new-password
   length 8, and a change-the-default-password prompt shown after login
   while the default password is still in use.
2. **Backups**: full SQLite snapshots (VACUUM INTO) with list /
   download / delete / restore APIs; restore is validated and STAGED —
   applied at the next process start with the previous DB kept as
   .pre-restore-<ts>. Automatic daily backup keeps the newest 7
   (BACKUP_AUTO=0 disables). Runtime page → Backups panel.
3. **Per-account daily caps**: provider_accounts.daily_cap_usd; today's
   spend comes from usage_log; the router excludes capped accounts from
   key and session rotation (15 s memoized check; the provider's
   default connection still serves; a pinned capped account fails with
   a clear error). Provider page shows cap + spent-today + CAPPED badge.
4. **Claude/Codex subscription quota**: /api/oauth/usage (Claude:
   5-hour, 7-day, Opus, Sonnet windows) and wham/usage (Codex: primary
   + weekly windows) fetched per account with a 60 s cache, rendered
   through the same accountQuotas buckets as Antigravity. Parsers
   unit-tested; live data appears once those providers are connected.
5. **ChatGPT Sentinel PoW**: the chat-requirements flow + SHA3-512
   proof-of-work solver (gAAAAAC/gAAAAAB tokens) now runs headlessly
   in the shared ChatGPT driver. LIVE RESULT: the flow reaches the
   requirements stage, and ChatGPT then demands a Turnstile token for
   this session/IP — that token can only be minted by a real browser
   (why OmniRoute drives one), so chat remains blocked there; the
   failure now says exactly that instead of an opaque HTTP 403, and
   the circuit breaker keeps repeat attempts free. Closing this fully
   needs a browser-bridge service (separate build).
6. **Retention + mobile**: usage_log retention (default 180 days,
   0 = forever; Settings → Security → Data retention; pruned at boot
   and daily). Logs/Analytics/Costs tables scroll horizontally on
   mobile with a minimum column width instead of crushing.
7. **Smoke E2E**: tests/smoke.e2e.test.ts boots the real gateway
   against a stub upstream and walks login → key → models → chat →
   cache hit → breaker fail-fast → backups → quotas over HTTP.
Core suite: 481/481 (64 files); web-session pack: 228/228.
Known small issue spotted during verification: the Antigravity
DEFAULT account's quota group intermittently disappears from
/api/quotas (its chat path is healthy; the DB account's 22 buckets
load fine) — the quota fetcher skips accounts whose retrieveUserQuota
call fails; to be diagnosed separately.

## Browser bridge — ChatGPT Web works (2026-10-20, late evening)
The Turnstile wall from the hardening batch is now actually solved,
the way OmniRoute solves it: with a real browser.
- **services/browser-bridge/**: a small internal-only service
  (headless Chrome-for-Testing + puppeteer-core) that runs each
  ChatGPT turn INSIDE chatgpt.com — the page's own Sentinel flow
  (prepare → finalize → req) completes invisibly, Turnstile included.
  Turns are serialized (small host), each in a fresh browser context
  (cookies never leak between accounts), Chrome pre-warmed at boot.
- **Driver**: ChatGptWebDriver (both chatgpt-web and
  chatgpt-web-free) routes turns through the bridge when
  CHATGPT_BRIDGE_URL is set; docker-compose wires it to the internal
  service (no host port published). Without it, the previous
  PoW-only behavior + clear Turnstile error remain.
- Extraction handles both layouts: role-marked nodes (logged-in
  desktop) and the anonymous mobile-web plain-text transcript
  ("You said: / ChatGPT said:") — the role nodes do not exist there.
- LIVE PROOF (2026-10-20): provider test ok in ~9s ("ok"); a real
  /v1/chat/completions call answered "Dhaka" via chatgpt-web-free.
  Expect ~10–30s per ChatGPT web reply (a real page turn), one at a
  time. Pack suite 231/231.

## Auto-combo resilience fixes (2026-10-20, late evening)
A dashboard screenshot showed every auto/* combo at "0/6 targets".
Root causes found and fixed, each verified live:
1. **Key-cooldown cascade (the big one)**: a single model's 401
   ("you need to sign in to use this model") cooled the provider's
   ONLY key for 60s provider-wide, so every later target on that
   provider died instantly with "no healthy account keys" — and
   repeated test clicks kept re-poisoning it. Auth failures now cool
   only the (key, model) pair; 429s still cool the whole key.
2. **Provider diversity**: auto candidate lists cap any provider at
   3 of 6 slots (backfill when alternatives run out) — no more
   single-provider monocultures.
3. **Category backfill**: auto/best-coding and best-reasoning append
   strong general models (Claude/Gemini/GPT — genuinely capable, just
   not name-matched) as fallback candidates past the limit.
4. **Health-aware ordering**: candidates whose circuit breaker is
   open sink to the end of auto lists (router synthesis + combo
   tests) — proven-dead models stop crowding out healthy ones.
   auto/best-coding went 0/6 → resolves via OVH Llama-3.3-70B;
   auto/best-reasoning resolves via Antigravity Claude Opus.
Upstream realities the gateway now routes around (not gateway bugs):
Kilo demands sign-in for most non-:free models, Pollinations moved
models behind x402 payment, LLM7's daily quota was exhausted.
Core suite: 489/489.

## Media page model picker (2026-10-21)

The Media page (Image / Audio / Video generation tester) previously
sent requests with no model, so the gateway silently picked its
default media provider. It now has a per-tab model picker:

- Models load from the dashboard catalog (GET /api/catalog — the
  dashboard's own login, no gateway key needed; /v1/models with the
  pasted gateway key is the fallback) and are filtered per tab with
  the same capability regexes as the Models page (image / TTS /
  video), shown as provider:model ids. Load failures are shown in
  the UI instead of a silently empty picker (an admin key pasted as
  the gateway key 401s /v1/models — the original bug report).
- "Auto (gateway default)" preserves the old behavior (no model
  field sent); picking a model pins the request to provider:model.
- The selection is remembered per tab in localStorage
  (llmswitch_media_model); a saved model that disappears from the
  list falls back to Auto.

## ChatGPT Web image generation via the bridge (2026-10-21)

ChatGPT's site can generate images, and the gateway can now return
them — through the browser bridge, for the chatgpt-web /
chatgpt-web-free providers:

- Bridge: /turn accepts `wantImage`; the poll loop also scans the
  rendered conversation for a generated image (estuary/oaiusercontent
  /blob sources or a "Generated image" alt), downloads it in-page
  (session cookies apply) and returns { b64, mime }. A still-loading
  image keeps an image turn alive past text stability; plain text
  turns capture an already-rendered image opportunistically.
- Driver: WebChatDriver gains an optional generateImage(); the
  ChatGPT drivers implement it via the bridge (the free driver
  inherits it). Chat turns that produce an image append it to the
  reply as a markdown data URL.
- Core: POST /v1/images/generations with a pinned chatgpt-web*
  model runs executeWebChatImage instead of the OpenAI-wire
  passthrough, and answers in OpenAI images format ({ data:
  [{ b64_json }] }). The route no longer hard-requires `model`
  (missing = "auto", which also fixes the Media page's Auto mode).
- Media page: the Image tab now lists the ChatGPT web models too.
- Honest limit: image generation needs a LOGGED-IN ChatGPT session
  — anonymously ChatGPT refuses, and the refusal text is surfaced
  in the error. Import a logged-in session to use it.
Pack suite: 235/235 (4 new bridge image tests). Core: 489/489.

## Antigravity + NVIDIA image delivery (2026-10-21)

- **Antigravity**: gemini-3.1-flash-image is entitled on the owner's
  account (probed: Google generates, ~1.5k tokens/image) but the
  executor's text-only stream parsing silently dropped the image
  part. extractText now collects inlineData/inline_data parts;
  parseAntigravitySSE dedupes them across cumulative snapshots;
  chat replies (stream + aggregate) append the image as a markdown
  data URL. /v1/images/generations with a pinned antigravity image
  model runs a pinned chat turn and unwraps the data URL into
  OpenAI images shape. 3 new executor tests (492 core total).
- **NVIDIA**: flux.1-schnell added to the catalog; /v1/images with
  nvidia:black-forest-labs/flux.1-schnell posts to the genai surface
  (ai.api.nvidia.com/v1/genai/…) with the FLUX width/height payload
  (aspect_ratio is rejected upstream — probed). NOTE: NVIDIA's free
  genai queue accepted the request but did not answer within 240s
  in repeated probes — the path is wired and schema-validated, the
  upstream free queue is the blocker.
- **Media page**: one-click "Create a gateway key for me" button
  (creates a media-page key via /api/keys and fills the box) — the
  paste-a-key step blocked first use.

## Rotation error-masking fix (2026-10-21)
The session-account loop appended the default (no-account) candidate
last; when a real account failed (e.g. Antigravity 429 "exhausted
your capacity on this model — resets after ~4h24m") and the default
candidate had no session, the surfaced error was the default's
misleading "no session — run: llmswitch login" instead of the real
verdict. The loop now keeps the first real-account error and prefers
it when giving up. (Live case: the owner's Antigravity image quota
was exhausted by gateway testing; the dashboard showed a 502
"no session" — the account page's lastError held the true 429.)

## Media passthrough pin-strip + friendlier failures (2026-10-21)
- passthroughJson now strips the "provider:" pin prefix from the
  forwarded model id — Pollinations rejected pinned ids verbatim
  ("Invalid model or alias: pollinations:flux"). This unbreaks every
  pinned media/embeddings/rerank passthrough, not just images.
- NVIDIA genai branch: timeout 240s → 90s (Cloudflare gives up
  ~100s anyway) with a clear "free image queue overloaded" message
  instead of a raw abort / proxy 524 page.
- Media page: HTML error pages (Cloudflare 502/524) are rendered as
  a one-line friendly message with the page title, never raw HTML.

## Duck.ai image generation (2026-10-21)
Duck.ai grew a "New Image" feature (OpenAI-powered, free, daily
limit) — the gateway now exposes it. Wire format (spiked live): the
ordinary anonymous chat flow with canDelegateImageGeneration: true
+ canUseTools: true; the orchestrator model (gpt-6-luna) invokes
its GenerateImage tool and the SSE stream carries the picture as
base64 in generate-image ui-component events (partial preview, then
status "success"). New core executor executeDuckDuckGoImage (session
setup factored into openDdgSession, shared with chat), catalog
model "duck-image" on duckduckgo-web, /v1/images branch, and chat
with duckduckgo-web:duck-image returns a markdown data URL. 3 new
tests (496 core total). Note: Duck.ai's daily limit is IP-based —
all gateway traffic shares the VPS IP's pool.

## Media page image rendering fix (2026-10-21)
Successful generations showed raw JSON instead of the picture:
postV1 display-truncated the body at 2000 chars, so the render
step's JSON.parse of a several-hundred-KB base64 payload always
failed. postV1 now also returns the full body; the Image tab
parses that, sniffs the mime from the base64 prefix, and shows a
short "Image received" caption under the rendered image.

## Image editing via Antigravity (2026-10-21)
POST /v1/images/edits now has a real branch: when the multipart
model pins antigravity, a small built-in multipart reader extracts
the image + prompt, and executeAntigravityImageEdit sends the
picture as a Gemini inlineData part next to the instruction
(buildAntigravityEnvelope gained extraUserParts); the edited
picture comes back in the usual images-API shape. The Media page
Image tab gained an edit mode (file picker + prompt → Edit Image).
Duck.ai editing could NOT be wired: its upload pipeline sits
behind a moderation-token + encrypted-stream protocol (every
plain-payload variant returns ERR_BAD_REQUEST) — the edits route
says so honestly when duckduckgo-web is pinned. Generation via
Duck works (see the Duck.ai section above).

## Gemini Web provider (2026-10-21)
New cookie provider "gemini-web" (registry count 258 -> 259, cookie
providers 17 -> 18): a web-session pack driver speaking the classic
gemini.google.com StreamGenerate protocol directly over HTTP
(SNlM0e/cfb2h lifted from /app; candidates parsed defensively).
OmniRoute's own gemini-web drives the site with Playwright and
retired its image model; this port instead implements chat plus a
tentative generateImage (returns/downloads generated-image URLs
when Google sends them) — NEEDS LIVE VERIFICATION with the user's
own __Secure-1PSID cookies. Model choice is account-side on the
web. Core: catalog def + gemini-web added to
WEBCHAT_IMAGE_PROVIDER_IDS so /v1/images routes to it once a
session is imported.

## Gemini proxy 502 fix (2026-10-21)
The login-window proxy (and any gateway fetch) to gemini.google.com
died with HeadersOverflowError: Google answers with >16KB of
response headers, over Node fetch's default cap — the proxy
surfaced it as a 502. docker-compose now starts the gateway with
NODE_OPTIONS=--max-http-header-size=131072 (verified: /app goes
from fetch-failed to 200).

## Connect extension: Gemini Web (2026-10-21)
The connect extension's provider list gained gemini-web, and it
now also reads parent-domain cookies for it: Gemini's login
cookies (__Secure-1PSID/__Secure-1PSIDTS) live on .google.com, so
a gemini.google.com-only read returns an anonymous session (the
login-window proxy capture has the same blind spot — it only ever
sees the gemini.google.com origin and saved just NID/COMPASS).

## Provider detail: reconnect is always reachable (2026-10-21)
The whole connect section rendered only when NOT connected, so a
stale/anonymous auto-saved session (e.g. the login-window proxy
capturing pre-login cookies) trapped the user: "connected" with
no way to open the login window or paste a fresh session. A
connected provider now shows a Reconnect bar that reopens the
connect section in place.

## Proxy header allowlist (2026-10-21)
The login-window proxy forwarded nearly all upstream headers;
Google's >8KB header pile overflowed the nginx buffer in front of
the gateway ("upstream sent too big header") and the proxied page
502'd through the domain while working fine locally. The proxy
now forwards only content-type/cache validators/auth headers
(location still rewritten separately). The VPS nginx site also
gained proxy_buffer_size 128k / proxy_buffers 8 128k as a second
layer.

## Gemini Web: honest login guidance (2026-10-21)
The Gemini detail page now warns on the login-window button that
Google blocks proxied sign-ins (verified live: the proxied SPA
loads but its API calls fail, and Sign-in 404s through the proxy)
and points to the Kiwi + Connect extension flow instead.
