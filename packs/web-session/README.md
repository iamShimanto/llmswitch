# @llmswitch/web-session — opt-in web-session packs

**Status: EXPERIMENTAL. Default OFF. Not installed with the core gateway.**

These packs drive unofficial web endpoints using *your own* browser session
(cookies) or OAuth tokens. This may violate providers' Terms of Service —
accounts can be limited or banned, and sessions break when providers change
their web apps. Prefer official API providers for anything important.

## Packs

| Pack | Auth | Env var |
|---|---|---|
| antigravity | OAuth refresh | `ANTIGRAVITY_OAUTH_REFRESH_TOKEN` |
| claude-web | cookies | `CLAUDE_WEB_COOKIES` |
| chatgpt-web | cookies | `CHATGPT_WEB_COOKIES` |
| copilot-web | cookies | `COPILOT_WEB_COOKIES` |
| grok-web | cookies | `GROK_WEB_COOKIES` |

Cookie format: Netscape cookie-file text or a raw `a=1; b=2` header value.

## What's real vs experimental

- **Real, tested:** `CookieJar` (Netscape + raw formats, expiry, domain scoping),
  `OAuth2Client` (refresh_token grant with caching),
  `DeviceFlowClient` (RFC 8628 device authorization: start → user code → poll,
  handles `authorization_pending` / `slow_down` / `access_denied`),
  `CookieChatDriver` (cookie-authenticated chat via any OpenAI/Anthropic-wire
  web endpoint), `sessionStore` (0600 sessions in `~/.llmswitch/sessions/`),
  pack manifests.
- **Real (mock-verified, needs your Google account to go live):** the Antigravity
  provider — `src/providers/antigravity.ts` implements the full protocol (OAuth
  authorization-code flow via loopback, `loadCodeAssist`, `onboardUser` with LRO
  polling, Cloud Code project bootstrap, fingerprint headers, request envelope).
  All request/response shapes are covered by mock tests. The end-to-end flow
  cannot be verified from CI/datacenter VMs — **you must run
  `llmswitch login antigravity` from your own machine and your own Google
  account.** Google may block or revoke the embedded public OAuth client,
  change the internal API, or limit your account at any time; this is an
  unofficial reverse-engineered flow, not a Google-supported integration.
- **Browser login (dashboard):** with the gateway running, open the dashboard →
  Providers page → "Connect Antigravity". The gateway returns a Google consent
  URL (`GET /api/oauth/antigravity/start`), Google redirects back to
  `GET /api/oauth/antigravity/callback` (protected by a single-use random
  `state`, since a browser redirect cannot carry the admin key), the code is
  exchanged server-side, the Cloud Code project is bootstrapped, and the
  session is saved to the same `~/.llmswitch/sessions/antigravity.json` (0600)
  the CLI login writes — CLI and browser logins are interchangeable.
  `GET /api/oauth/antigravity/status` returns metadata only (email, projectId,
  expiresAt — never tokens); `POST /api/oauth/antigravity/disconnect` deletes
  the session. Same caveat as above: mock-verified only, needs your real
  Google sign-in in your own browser to work end-to-end.
- **Also real (mock-verified, needs your accounts to go live):** Claude +
  Codex OAuth — `src/providers/claude.ts` / `codex.ts` implement authorization
  code + PKCE logins with the public Claude Code / Codex CLI OAuth clients
  (no client_secret): `llmswitch login claude` / `llmswitch login codex`, or
  the dashboard Providers page "Connect Claude" / "Connect Codex" buttons
  (`/api/oauth/{claude,codex}/start|callback|status|disconnect`, same
  state-protected callback pattern as Antigravity). Sessions land in
  `~/.llmswitch/sessions/claude.json` / `codex.json` (0600). ⚠️ The OAuth
  scope lists are the standard CLI sets (OmniRoute's code pins endpoints and
  client ids but no scopes) — they need confirmation against a real login,
  and OpenAI may restrict the redirect URI for the public Codex client.
  Routing subscription traffic through these clients may violate
  Anthropic/OpenAI Terms of Service.
- **CLI:** `llmswitch login [name] --provider github --client-id <id>` (device flow),
  `llmswitch login antigravity [--refresh-token <rt>]` (Google OAuth),
  `llmswitch sessions` / `logout`, `llmswitch cookies <name> --domain <d> [--file f]`
  (import your own browser cookies), `llmswitch cookie-chat <session> --url <endpoint> "prompt"`.
- **Experimental:** the per-site request protocols (claude-web, chatgpt-web, …).
  They need verification against a live logged-in session, which can't be done in CI.
  Note: DuckDuckGo's keyless web-chat was probed live and is currently blocked by
  their anti-bot challenge (HTTP 418 `ERR_CHALLENGE`) from datacenter IPs — the
  transport works, but the provider blocks this environment.
