# LLMSwitch — FULL PLAN (single document)

> Consolidated from PLAN.md, FEATURES.md, TECH_STACK.md, RUN.md, PROVIDERS.md
> Status: PLANNING — build not started. Date: 2026-10-20

---

## PART A — Vision, Decisions, Architecture, Phases

> Open-source (MIT) AI gateway. OmniRoute-scale parity + new differentiators.
> Status: PLANNING — build not started. All docs: `~/workspace/llmswitch/`

## 1. Vision (one line)

**One endpoint, every AI** — `http://localhost:6000/v1` diye 375 provider, auto-fallback,
quota-aware routing, ar khoroch control — sob open source, sobar jonno.

## 2. Locked decisions

| Decision | Value |
|---|---|
| Name | **LLMSwitch** (npm `llmswitch` free ✓) |
| License | MIT (OmniRoute er moto) |
| Language | TypeScript, Node.js 22 (Python bad — slow) |
| API server | Express (user stack) |
| Dashboard | React + Vite + Tailwind |
| Database | SQLite local, zero-config (`./data/llmswitch.db`); Postgres optional P1 |
| Port | **6000** (busy → auto next free; `PORT=` override) |
| Startup | Clone & run — `npx llmswitch` / docker / `pnpm dev`, dashboard → key add → `/v1` use |
| Providers | **Sob 375 entry (272 family)** port — Tier 1 (248 config-only) day-one |
| Auth | API key, OAuth 2.0, cookie/session jar (core); web-session packs opt-in, default OFF |
| Monorepo | pnpm workspaces: `core` / `dashboard` / `cli` |

## 3. Architecture (request flow)

```
Client (Cursor/Cline/Codex/any OpenAI client)
        │  POST /v1/chat/completions  (Bearer <llmswitch-key>)
        ▼
┌───────────────┐   ┌──────────────┐   ┌───────────────┐   ┌──────────────┐
│  Ingress      │──▶│  Router      │──▶│  Translator   │──▶│  Executor    │
│  auth, limits │   │  20 strategy │   │  OpenAI↔Anth  │   │  provider    │
│  validation   │   │  quota-aware │   │  ropic↔Gemini │   │  API call    │
└───────────────┘   └──────────────┘   └───────────────┘   └──────────────┘
        │                    │ fallback on 429/5xx/timeout │      ▲
        │                    └─────────────────────────────┘      │
        ▼                                                        │ SSE stream
┌───────────────┐   ┌──────────────┐   ┌───────────────┐          │ normalize
│  Dashboard    │◀──│  SQLite      │◀──│  Observability│◀─────────┘
│  :6000        │   │  keys,usage  │   │  logs,metrics │
└───────────────┘   │  quotas      │   │  cost         │
                    └──────────────┘   └───────────────┘
```

**Core modules** (`packages/core/src/`):
- `ingress/` — Express routes, auth, rate limits, validation (zod)
- `providers/` — registry (375 entries) + one-file-per-provider adapters
- `router/` — 20 strategies, quota-aware scheduler, fallback chains
- `translator/` — format translation, tool-call emulation, modality bridge
- `executor/` — generic OpenAI-compatible executor + custom executors
- `compression/` — caveman + RTK + stacked pipeline (P1)
- `cache/` — exact-match → semantic (P2)
- `quota/` — per-account trackers, cooldown/backoff, budget caps [N]
- `billing/` — cost tracking, forecasting [N]
- `store/` — SQLite (keys, usage, quotas, audit)
- `web/` — serves dashboard SPA statically

## 4. Phase plan

### P0 — MVP (~2–3 weeks): "cholbe"
- [ ] Monorepo scaffold + CI (lint/typecheck/test/docker)
- [ ] Ingress: `/v1/chat/completions`, `/v1/models`, SSE streaming, key auth
- [ ] Providers: Tier 1 (248 config-only) + generic executor
- [ ] Router: 6 core strategies (priority, round-robin, weighted, least-used, cost-optimized, random) + fallback
- [ ] Quota: basic rate-limit manager + cooldown/backoff
- [ ] Dashboard v0: home, providers, usage, keys
- [ ] SQLite store, `npx llmswitch` + docker + `pnpm dev` all working
- [ ] Docs: README quick-start, CONTRIBUTING, LICENSE

**MVP done =** tool theke `localhost:6000/v1` e request → auto route + fallback across providers. ✅

### P1 (~1–2 months): "dashboard + brain"
- [ ] Full 20 strategies, combos, quota telemetry per provider
- [ ] Translation layer full (Anthropic/Gemini/etc.), tool-call emulation
- [ ] Compression (caveman + RTK), caching, playground, request inspector
- [ ] Cost mgmt: budgets, caps, forecasting, CSV reports [N]
- [ ] Smart task-based routing [N], webhooks/alerts [N]
- [ ] CLI, model auto-discovery [N], local Ollama [N]
- [ ] Tier 2 providers (24 custom-logic)
- [ ] npm publish + Docker Hub + release channels

### P2 (later): "scale + edge"
- [ ] Fan-out, semantic cache, prompt auto-optimizer [N]
- [ ] MCP/A2A, agent skills, orchestration
- [ ] Media (image/video/TTS), batch API, web search
- [ ] Web-session provider packs (opt-in, OFF default)
- [ ] Desktop (Electron), PWA, chaos engineering
- [ ] Team workspaces [N], Python/TS SDKs

## 5. Repo structure (day 1)

```
llmswitch/
├── packages/core/src/{ingress,providers,router,translator,executor,quota,store,web}
├── packages/dashboard/src/{pages,components}
├── packages/cli/src
├── examples/
├── docs/  (FEATURES, TECH_STACK, RUN, PROVIDERS, PLAN)
├── docker-compose.yml  Dockerfile  .env.example
├── LICENSE  README.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md
└── pnpm-workspace.yaml
```

## 6. Non-goals / explicit exclusions

- Web-session scrapers **core e na** (opt-in pack, P2)
- 60-language docs (EN first)
- Microservices / K8s in P0 (single image until needed)

## 7. Pending (tomar input lagbe jokhon asbe)

- GitHub org/user name (repo URL)
- npm publish account
- Dashboard UI language: English only, naki Bangla option? (P2)
- P0 start er greenlight ⏳

---

## PART B — Tech Stack

Decisions with one-line rationale. Alternatives considered at the bottom.

## Core decisions

| Layer | Choice | Keno |
|---|---|---|
| Language / runtime | **TypeScript, Node.js 22 LTS** | Provider SDK ecosystem sobcheye boro; server + dashboard ek language e |
| API server | **Express** | Sobcheye porichito Node framework; contributor-friendly, ecosystem sobcheye boro |
| Dashboard | **React + Vite + Tailwind CSS** | Admin dashboard e SSR dorkar nai — Vite SPA halka, build fast |
| Database | **SQLite (default), Postgres (optional)** | Zero-config self-host (`docker compose up` ei cholbe); scale lagle Postgres e switch |
| Cache | **In-memory (P0), Redis optional (P1)** | MVP te external dependency zero rakhai goal |
| Schema validation | **Zod** | Config + request validation, TypeScript-first |
| Logging | **Pino** | Fast JSON logs, request tracing ready |
| Tests | **Vitest** | Unit + integration, fast, TS-native |
| Package manager | **pnpm workspaces** | Monorepo: `core` / `dashboard` / `cli` |
| Lint / format | **ESLint + Prettier, TS strict** | Contributor-friendly, CI-gated |
| CI/CD | **GitHub Actions** | lint → typecheck → test → docker build → publish |
| Packaging | **npm (`npx llmswitch serve`) + Docker image** | OmniRoute-style distribution |
| Config | **YAML + env vars, hot-reload** | Restart charai provider/routing change |

## Monorepo layout (planned)

```
llmswitch/
├── packages/
│   ├── core/          # gateway engine: registry, router, translators, executors
│   ├── dashboard/     # React + Vite SPA (served statically by core)
│   └── cli/           # npx llmswitch serve / providers / test
├── examples/          # copy-paste configs
├── docs/
└── docker-compose.yml
```

## Key library choices (core)

- **HTTP client:** native `fetch` (Node 22) + `undici` tuning for proxying
- **SSE streaming:** Express + async generators, per-provider stream normalizers
- **Rate limiting:** token-bucket per key + per provider account
- **Secrets:** env / file, encrypted at rest (P1: age/sops)
- **Migrations:** lightweight SQL files (no heavy ORM — `node:sqlite` / `pg` directly, or kysely P1)

## Rejected alternatives

| Alternative | Bad keno |
|---|---|
| Fastify | Technically fast, kintu Express er tulonay porichiti kom — "sobai use korte parbe" goal er jonno Express |
| Python (FastAPI) | Async SSE streaming + single-binary/npm packaging clunky; dashboard alada language hobe |
| Go | Proxy hishebe bhalo, kintu provider SDK ecosystem thin — sob adapter haate likhte hobe |
| Next.js for dashboard | SSR overkill for admin UI; Vite simpler |
| Bun runtime | Fast kintu ecosystem ekhono young; contributor friction |
| MongoDB | Relational data (keys, quotas, usage) — SQLite/Postgres e natural |

## Non-goals for stack

- No Kubernetes manifests in P0 (docker-compose enough)
- No microservices — single deployable binary/image until scale demands it

---

## PART C — Full Feature List

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

## PART D — Run / Startup

Goal: **clone/download kore 2 minute e running** — kono external DB, kono complex setup na.

## 4 ways to run

### 1) npm (easiest)

```bash
npm install -g llmswitch
llmswitch
```

or without installing:

```bash
npx llmswitch
```

### 2) Docker

```bash
docker run -d --name llmswitch --restart unless-stopped \
  -p 127.0.0.1:6000:6000 \
  -v llmswitch-data:/app/data \
  llmswitch/llmswitch:latest
```

### 3) From source (clone & run)

```bash
git clone https://github.com/<org>/llmswitch.git
cd llmswitch
pnpm install
pnpm dev
```

### 4) docker-compose

```bash
docker compose up -d
```

## First run (sob method e same)

1. Dashboard kholo: **http://localhost:6000**
2. **Providers** → provider choose koro → API key add koro (free-tier key diye shuru kora jay)
3. **Endpoints** theke gateway API key copy koro
4. Tomar coding tool e boshao:

```txt
Base URL: http://localhost:6000/v1
API Key:  [dashboard → Endpoints theke copy]
Model:    auto
```

## Local DB

- **SQLite**, zero config. First run e auto-create hoy:
  - npm/source: `./data/llmswitch.db`
  - docker: `/app/data/llmswitch.db` (volume e persist)
- Keys, provider config, usage logs, quotas — sob local DB te. Bahirer kichu lagbe na.
- Scale lagle `DATABASE_URL=postgres://...` dile Postgres e switch (P1).

## Verify

```bash
curl http://localhost:6000/v1/models -H "Authorization: Bearer <tomar-key>"
```

Connected model list dekhalei done 🎉 — ekhon tool theke request pathao, LLMSwitch auto route + fallback korbe.

## Notes

- Port default **`6000`** (mone rakha easy). Busy thakle auto next free port nebe (6001, 6002…) ar console e print korbe — Vite er moto behavior.
- Pin korte chaile: `PORT=4001 llmswitch`
- Data backup = `data/` folder copy korlei hoy
- Dashboard + API ekoi port e (OmniRoute er moto alada port na)

---

## PART E — Provider Catalog (all 375 entries)

> Source: OmniRoute v3.8.53 `open-sse/config/providers/registry/` — **272 families / 375 entries**.
> License: MIT — provider configs adapted with attribution (THIRD_PARTY_NOTICES).
>
> Port tiers:
> - **Tier 1 — config-only (248 families):** single-file registry entries (id, baseUrl, format, auth, models).
>   Mechanical port; works with the generic executor on day one.
> - **Tier 2 — custom registry logic (24 families):** multi-file entries needing special handling
>   (sub-accounts, regions, token plans, web variants). Ported in priority order.
> - **Tier 3 — custom executors:** providers needing bespoke executors (OAuth flows, SigV4,
>   web-session packs) — ported per PROVIDERS priority list, P1/P2.

## Tier 1 — config-only (252 families)

- [ ] adapta-web
- [ ] agentrouter
- [ ] agy
- [ ] ai21
- [ ] aimlapi
- [ ] ainative
- [ ] aion
- [ ] ant-ling
- [ ] anthropic
- [ ] antigravity
- [ ] anyapi
- [ ] api-airforce
- [ ] apmix
- [ ] arcee-ai
- [ ] auggie
- [ ] auriko
- [ ] bai
- [ ] baichuan
- [ ] baidu
- [ ] bailian-coding-plan
- [ ] baseten
- [ ] bazaarlink
- [ ] beatapi
- [ ] bedrock
- [ ] bigmodel
- [ ] bluesminds
- [ ] byteplus
- [ ] bytez
- [ ] cerebras
- [ ] charm-hyper
- [ ] chat-oripe
- [ ] chatanywhere
- [ ] chatgpt-web
- [ ] chatgpt-web-codex
- [ ] chatplayground
- [ ] chenzk
- [ ] chutes
- [ ] cline
- [ ] clinepass
- [ ] cloudcode-one
- [ ] cloudflare-ai
- [ ] cloudflare-playground
- [ ] clova-studio
- [ ] codebuddy-cn
- [ ] codebuddy-intl
- [ ] codestral
- [ ] codex
- [ ] codex-app-server
- [ ] cohere
- [ ] command-code
- [ ] conol-web
- [ ] copilot-m365-web
- [ ] copilot-web
- [ ] coze
- [ ] crof
- [ ] dahl
- [ ] daoxe
- [ ] databricks
- [ ] deepai
- [ ] deepinfra
- [ ] demonroute
- [ ] devin
- [ ] devin-cli
- [ ] devin-cli-agentic
- [ ] devin-desktop
- [ ] dgrid
- [ ] dify
- [ ] digitalocean
- [ ] dit
- [ ] duckduckgo-web
- [ ] dxnt
- [ ] electronhub
- [ ] eurouter
- [ ] factory
- [ ] fastrouter
- [ ] featherless-ai
- [ ] fireworks
- [ ] free-ai
- [ ] freeaiapikey
- [ ] freebuff
- [ ] freeinference
- [ ] freemodel-dev
- [ ] freetheai
- [ ] friendliai
- [ ] g4f-gemini
- [ ] g4f-groq
- [ ] g4f-nvidia
- [ ] g4f-ollama
- [ ] g4f-pollinations
- [ ] galadriel
- [ ] ghe-copilot
- [ ] gigachat
- [ ] gitlab-duo
- [ ] greenpt
- [ ] grok-cli
- [ ] grok-web
- [ ] groq
- [ ] haiper
- [ ] hcnsec
- [ ] helixmind
- [ ] helyxai
- [ ] heroku
- [ ] huggingchat
- [ ] huggingface
- [ ] hyperagent
- [ ] hyperbolic
- [ ] ideogram
- [ ] iflytek
- [ ] inception
- [ ] inference-net
- [ ] inner-ai
- [ ] internlm
- [ ] kenari
- [ ] kilo-gateway
- [ ] kilocode
- [ ] kiro
- [ ] lambda-ai
- [ ] leonardo
- [ ] liquid
- [ ] literouter
- [ ] llamagate
- [ ] llm-kiwi
- [ ] llm7
- [ ] llmgateway
- [ ] logfare
- [ ] longcat
- [ ] lyceum
- [ ] magnific
- [ ] maritalk
- [ ] maxai
- [ ] meganova-ai
- [ ] meta-llama
- [ ] mistral
- [ ] mixlayer
- [ ] mlx
- [ ] mnn-ai
- [ ] modal
- [ ] modelscope
- [ ] monsterapi
- [ ] moonshot
- [ ] morph
- [ ] muse-spark-web
- [ ] naga-ac
- [ ] naga-ai
- [ ] nan
- [ ] nanogpt
- [ ] nara
- [ ] navy
- [ ] nebius
- [ ] nlpcloud
- [ ] notion-web
- [ ] notrack-web
- [ ] nous-research
- [ ] novita
- [ ] nscale
- [ ] nube
- [ ] nvidia
- [ ] ofoxai
- [ ] ollama-cloud
- [ ] oneminai
- [ ] onomeo
- [ ] openadapter
- [ ] openai
- [ ] opencode
- [ ] openference
- [ ] openference-api
- [ ] openrouter
- [ ] openvecta
- [ ] opper
- [ ] orcarouter
- [ ] ovhcloud
- [ ] pioneer
- [ ] plamo
- [ ] poe
- [ ] poixe-ai
- [ ] pollinations
- [ ] poolside
- [ ] predibase
- [ ] promptql
- [ ] publicai
- [ ] qianfan
- [ ] qiniu
- [ ] qoder
- [ ] qwen-cloud
- [ ] qwen-cloud-token-plan
- [ ] regolo
- [ ] reka
- [ ] requesty
- [ ] routeway
- [ ] sambanova
- [ ] sarvam
- [ ] scaleway
- [ ] sealion
- [ ] seekai
- [ ] segmind
- [ ] sensenova
- [ ] siliconflow
- [ ] snowflake
- [ ] sparkdesk
- [ ] speka
- [ ] stability-ai
- [ ] stepfun
- [ ] sumopod
- [ ] synthetic
- [ ] syntx
- [ ] t3-web
- [ ] tabitoken
- [ ] tencent
- [ ] tencent-aistudio-web
- [ ] tinycms
- [ ] together
- [ ] token-kiosk
- [ ] tokenmarket
- [ ] tokenreply
- [ ] tokenrouter
- [ ] trae
- [ ] twinmind
- [ ] typhoon
- [ ] uc
- [ ] uc-direct
- [ ] udio
- [ ] uncloseai
- [ ] unifically
- [ ] unorouter
- [ ] upstage
- [ ] v0-vercel
- [ ] venice
- [ ] veoaifree-web
- [ ] vercel-ai-gateway
- [ ] vertex
- [ ] void-ai
- [ ] wafer
- [ ] wandb
- [ ] workbuddy
- [ ] writer
- [ ] x5lab
- [ ] xai
- [ ] xiaomi-mimo
- [ ] xiaomi-mimo-token-plan
- [ ] xkiro
- [ ] y-api
- [ ] yi
- [ ] yolo-auto
- [ ] yuanbao-web
- [ ] zai
- [ ] zai-web
- [ ] zcode
- [ ] zed-hosted
- [ ] zenmux
- [ ] zenmux-free
- [ ] zerolimitai
- [ ] zylo-api

## Tier 2 — custom registry logic (20 families)

- [ ] agnes
- [ ] aihorde
- [ ] alibaba
- [ ] blackbox
- [ ] cheaperinference
- [ ] claude
- [ ] cursor
- [ ] deepseek
- [ ] doubao
- [ ] gemini
- [ ] github
- [ ] gitlawb
- [ ] glm
- [ ] kie
- [ ] kimi
- [ ] lmarena
- [ ] minimax
- [ ] muse-code
- [ ] perplexity
- [ ] volcengine

## Notes
- Checklist boxes track port status during build.
- Entry count 375 > family count 272 because some families expose sub-entries
  (e.g. `glm`, `glm/t`, `glm/cn`; `claude`, `claude/web`). All sub-entries ported.
