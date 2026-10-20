# LLMSwitch — Tech Stack

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
