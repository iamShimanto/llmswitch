# LLMSwitch vs OmniRoute — Full Gap Analysis

Audited 2026-10-20 against OmniRoute v3.8.53 tree (29,115 files) vs LLMSwitch P5.
Scale context: OmniRoute = ~8 months, team + heavy AI assistance. Exact 1:1
parity is not a one-session job; this doc is honest about where we stand.

## 1. API surface — `/v1/*` routes (OmniRoute: 68 route groups)

### ✅ Parity (36 route groups)
chat/completions, completions (legacy), responses (+ input_tokens),
messages (+ count_tokens), models (+ query), embeddings, multimodal-embeddings,
images/generations, images/edits, images/upscale, videos/generations,
audio/speech, audio/transcriptions, audio/translations, text-to-speech/[voiceId],
voices, speech-to-text, moderations, rerank, batches (+ delete-completed),
files, explain/routing, quotas/check, me/status,
search, web/fetch, web/map

### ❌ Missing — worth building
- `alpha/search` — variant of search; trivial to add if needed
- `ws` (realtime websocket) — needs `ws` dep + provider realtime support. Hard.

### ❌ Missing — low value / skip
- `classify`, `segment` — Jina-AI-specific proxies
- `ocr` — Vertex DeepSeek OCR specific
- `music/generations` — niche
- `combos`, `auto-combo` — OmniRoute-specific combo chains (long-term)
- `accounts`, `session-leases`, `registered-keys`, `agents/*` — multi-account
  rotation infra (long-term)
- `management/proxies`, `provider-plugin-manifest`, `media/[id]`,
  `video-bridge/drilldown`, `search/analytics`, `issues/report` — internal/ops
- `vscode/*`, `muse-code/models`, `antigravity`, `api/chat`, catch-all —
  client-specific shims
- `relay/chat` — 404s upstream, dead

## 2. Subsystems

| Subsystem | OmniRoute | LLMSwitch | Status |
|---|---|---|---|
| Routing strategies | 20 | 20 | **parity** |
| Compression engines | caveman + RTK + 131 rule/engine files + eval | caveman + RTK (original impl) | core parity |
| Provider families | 272 | 216 | 79% — rest need OAuth/cookie/SigV4 transports |
| Translators | 91 files (codex/cursor/kiro/clova…) | 2 (anthropic, gemini) | partial |
| Executors | 320 files (per-provider) | generic + web-session base | partial |
| MCP server | 17 tools | 6 tools | partial |
| Semantic cache | real embeddings + vector stores | TF-IDF local | partial |
| Usage/quota accounting | 56 per-provider files | header telemetry + price table | partial |
| Multi-account rotation | sessionPool/accountFallback/tokenRefresh | ❌ | missing |
| MITM proxy | 101 files | ❌ | missing |
| Skills system | 104 files | ❌ | missing |
| i18n | 144 files | ❌ (EN only) | missing |
| Dashboard | 122 sections | 8 pages | partial |
| CLI | 95 commands | 9 commands | partial |
| Electron desktop | shipped app | scaffold | partial |
| Docs | ~11,500 files | ~12 docs | partial |

## 3. What remains (honest, prioritized)

**P6 candidates (real value, buildable):**
1. ✅ Web search APIs — DONE (P6)
2. More MCP tools (pickFastestModel, ops, memory)
3. CLI depth (chat repl, doctor, setup-* for coding tools)
4. Dashboard depth (analytics, batch UI)

**Long-term (each a project):**
- 156 custom-transport providers, MITM proxy, skills system, i18n,
  combo chains, multi-account rotation, realtime websocket

**Needs the user (cannot build):**
- npm publish (NPM_TOKEN), GitHub repo push (org name),
  web-session protocol verification (live logged-in sessions),
  Docker runtime build test (no Docker in this VM)
