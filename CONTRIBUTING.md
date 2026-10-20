# Contributing to LLMSwitch

## Setup

```bash
git clone https://github.com/<org>/llmswitch.git && cd llmswitch
npm install
npm test
```

Requires Node.js 22+.

## Ground rules

- **Clean code**: typed, no `any` without justification, small focused modules.
- **One file per provider**: new providers go in
  `packages/core/src/providers/` as a single definition — no core changes needed.
- **Tests required**: every router/translator/executor change ships with vitest
  coverage. Run `npm test` before pushing.
- **No secrets in the repo**: keys only via env vars. CI scans for leaks.
- **Docs**: user-facing changes update `README.md`; new features update
  `FEATURES.md`.

## Pull requests

1. Fork → branch → PR against `main`.
2. CI must be green (lint, typecheck, tests).
3. Describe the provider/strategy added and how you tested it.
