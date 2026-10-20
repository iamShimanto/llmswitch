# LLMSwitch — Final Plan

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
