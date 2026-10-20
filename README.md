# ⚡ LLMSwitch — One Endpoint, Every AI

[![GitHub stars](https://img.shields.io/github/stars/iamShimanto/llmswitch?style=social)](https://github.com/iamShimanto/llmswitch)
[![CI](https://github.com/iamShimanto/llmswitch/actions/workflows/ci.yml/badge.svg)](https://github.com/iamShimanto/llmswitch/actions/workflows/ci.yml)
[![Docker Pulls](https://img.shields.io/docker/pulls/iamshimanto/llmswitch)](https://hub.docker.com/r/iamshimanto/llmswitch)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Open-source AI gateway (MIT). Point any OpenAI-compatible client at one local
endpoint and route across **256+ providers** with auto-fallback, quota-aware
routing, cost controls and a full dashboard.

## 🐳 Docker (fastest start)

```bash
docker run -d --name llmswitch -p 6000:6000 iamshimanto/llmswitch
```

Also on GHCR: `ghcr.io/iamshimanto/llmswitch`

Open http://localhost:6000 — the dashboard prints a bootstrap admin key in the
container logs on first run.

### docker compose

```bash
git clone https://github.com/iamShimanto/llmswitch.git
cd llmswitch
docker compose up -d
```

## Quick start
```bash
npx llmswitch
# or
npm install -g llmswitch && llmswitch
# or from source
git clone https://github.com/iamShimanto/llmswitch.git && cd llmswitch
npm install && npm --workspace @llmswitch/core run dev
# or docker
docker compose up -d
```

1. Open the dashboard: **http://localhost:6000**
2. Add a provider key: set e.g. `GROQ_API_KEY` in `.env` (copy `.env.example`) and restart —
   or manage keys in the dashboard later.
3. Copy your gateway API key (printed on first run, or dashboard → API Keys).
4. Point your tool:

```txt
Base URL: http://localhost:6000/v1
API Key:  <your llmswitch key>
Model:    auto
```

Verify:

```bash
curl http://localhost:6000/v1/models -H "Authorization: Bearer <key>"
```

## Features

- **OpenAI-compatible API**: `/v1/chat/completions`, `/v1/completions` (legacy),
  `/v1/responses` (Responses API), `/v1/messages` (Anthropic native) — SSE streaming
- **Media & tools APIs**: `/v1/embeddings`, `/v1/images/generations`, `/v1/images/edits`,
  `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations`,
  `/v1/videos/generations`, `/v1/moderations`, `/v1/rerank`, `/v1/files`, `/v1/batches`
- **Web search & fetch**: `/v1/search` (Tavily/Brave), `/v1/web/fetch` (SSRF-guarded),
  `/v1/web/map`, `/v1/explain/routing`
- **148 provider families** (auto-converted from the MIT OmniRoute catalog + 22 built-in)
- **20 routing strategies** (cost/latency/quota-weighted, session affinity, cooldown…)
- **Anthropic + Gemini translators**, generic SSE executor, tool-call emulation
- **Compression**: Caveman + RTK engines (`x-llmswitch-compress` header)
- **Cost management**: per-key budgets (warn/block), monthly forecasts, CSV export
- **Prompt cache + semantic cache** (TF-IDF, opt-in), request inspector + PII redaction
- **Playground** (fan-out compare), **model auto-discovery** (Ollama/LM Studio)
- **Team workspaces**, audit logs, alert webhooks, MCP server, CLI, Docker
- **Google Antigravity (OAuth, opt-in)**: sign in with your own Google account
  (`llmswitch login antigravity`) and route via `antigravity:<model>`. Unofficial,
  reverse-engineered flow against Google's internal Cloud Code API — Google may
  block/revoke it and it may violate ToS. See `packs/web-session/README.md`.
- **Claude + Codex (OAuth, opt-in)**: sign in with your own Anthropic/OpenAI
  subscription account (`llmswitch login claude` / `llmswitch login codex`, or
  the dashboard Providers page) and route via `claude:<model>` / `codex:<model>`.
  PKCE flows ported from the Claude Code / Codex CLI clients — unofficial,
  mock-verified only, may violate Anthropic/OpenAI ToS.
- **Keyless providers (no key needed)**: `pollinations`, `kilo-gateway`,
  `ovhcloud`, `llm7`, `duckduckgo-web` — always connected out of the box
  (dashboard shows a "No key needed — ready" badge). Free public tiers with
  strict anonymous rate limits; an optional (usually free) key just raises the
  limit. ⚠️ Honest caveats: DDG answers HTTP 418 anti-bot challenges from many
  datacenter IPs; pollinations' anonymous tier was demanding a free key in an
  Oct-2026 probe; llm7 only serves a subset keyless.

## Security model

- Binds **localhost only** by default (`HOST=0.0.0.0` to expose on LAN)
- `/v1/*` requires a gateway API key (scrypt-hashed, per-key RPM limits)
- Management APIs (`/api/*`) are open locally; set `ADMIN_KEY` to gate them
  (dashboard has a 🔑 field for it)

## Development

```bash
npm install
npm test                          # vitest (core)
npm --workspace @llmswitch/core run dev     # gateway on :6000
npm --workspace @llmswitch/dashboard run dev # dashboard on :5173 (proxies API)
```

## License

MIT — see [LICENSE](LICENSE).
