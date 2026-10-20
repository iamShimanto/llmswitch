# Changelog

## 0.1.0 — 2026-10-20 (first public release)

**Core gateway**
- Express gateway on :6000 (localhost-only by default, `HOST=` override, next-free-port fallback)
- OpenAI-compatible: `/v1/chat/completions`, `/v1/completions`, `/v1/responses`
  (stream + non-stream), `/v1/messages` (Anthropic native), `/v1/models`
- Media APIs: `/v1/embeddings`, `/v1/images/generations`, `/v1/images/edits`,
  `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations`,
  `/v1/videos/generations`, `/v1/moderations`, `/v1/rerank`
- `/v1/files` (upload/list/get/delete) and `/v1/batches` (create/list/get/cancel)
- Web search: `/v1/search` (Tavily/Brave via SEARCH_API_KEY), `/v1/web/fetch`
  (SSRF-guarded page text), `/v1/web/map` (link extraction)
- Explainability: `/v1/explain/routing` (real routing events + quality snapshot)
- 148 provider families (22 built-in + 126 converted from the MIT OmniRoute
  provider catalog), Anthropic + Gemini translators, generic SSE executor
- 20 routing strategies, quota-header telemetry, session affinity, cooldown,
  task-aware auto routing, tool-call emulation for non-OpenAI wires
- Prompt cache (exact) + semantic cache (TF-IDF, opt-in), Caveman + RTK
  prompt compression, request inspector with PII redaction (on by default)
- Cost management: per-key budgets (warn/block), monthly forecasts, CSV export
- Team workspaces, audit logs, alert webhooks, fan-out playground,
  Ollama/LM Studio auto-discovery

**Security**
- Gateway API keys (scrypt-hashed, per-key RPM limits); `/v1/*` always gated
- Optional `ADMIN_KEY` for management APIs; security headers; graceful shutdown

**Clients**
- CLI (`llmswitch serve|providers|test|keys|compress|chat|models|doctor|mcp`),
  MCP server (6 tools: chat, list_providers, compress, pick_fastest_model,
  get_stats, web_search),
  React dashboard (8 pages), Electron scaffold, Docker + compose, CI + release
  workflows
- Experimental opt-in web-session packs (CookieJar + OAuth2 real; 5 provider
  skeletons), separate package, default OFF with ToS warnings
