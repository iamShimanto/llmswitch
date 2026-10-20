# LLMSwitch — Full Feature List (v2 — complete)

> Open-source AI gateway (MIT). OmniRoute parity + new differentiators.
> Audit source: OmniRoute v3.8.53 tree — dashboard (~60 pages), `open-sse/services` (~300 modules),
> 272 provider families / 375 entries, ~296 executors, ~8k test files.
> Legend: `[P]` = OmniRoute parity · `[N]` = New (beyond OmniRoute) · Phases: `P0` MVP · `P1` v1 · `P2` later

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
