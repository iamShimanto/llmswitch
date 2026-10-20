import { type Request, type Response, type Express } from "express";
import { randomBytes } from "node:crypto";
import {
  buildClaudeAuthUrl,
  buildCodexAuthUrl,
  completeClaudeLoginWithCode,
  completeCodexLoginWithCode,
  deleteSession,
  generatePkce,
  loadClaudeSession,
  loadCodexSession,
  type SavedSession,
} from "@llmswitch/web-session";
import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";

/**
 * Browser-based OAuth login for PKCE providers (Claude / Codex) — mirrors
 * the Antigravity browser flow (src/oauth/antigravity.ts):
 *
 *   dashboard "Connect" → GET /api/oauth/<id>/start (admin-gated) returns
 *   the consent URL (PKCE S256) → user signs in → provider redirects to
 *   /api/oauth/<id>/callback?code=&state= → code exchanged server-side with
 *   the stored PKCE verifier, tokens saved to
 *   ~/.llmswitch/sessions/<id>.json (0600) → 302 back to the dashboard.
 *
 * The callback is NOT admin-gated (a browser redirect cannot carry the
 * admin key); it is protected by a single-use random `state` (10-min TTL)
 * that binds the PKCE verifier. Token values are never returned by any of
 * these endpoints.
 *
 * Endpoints/scopes are ported from OmniRoute (MIT) — see
 * packs/web-session/src/providers/{claude,codex}.ts. Mock-tested only;
 * needs the user's own Anthropic/OpenAI account to verify live.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

interface StateEntry {
  expiresAt: number;
  redirectUri: string;
  codeVerifier: string;
}

export interface ProviderOAuthFlow {
  id: string;
  sessionName: string;
  displayName: string;
  buildAuthUrl: (redirectUri: string, codeChallenge: string, state?: string) => string;
  completeLogin: (
    code: string,
    redirectUri: string,
    codeVerifier: string,
    fetchFn: typeof fetch,
  ) => Promise<SavedSession>;
  loadSession: () => SavedSession | null;
}

export interface ProviderOAuthDeps {
  config: AppConfig;
  store?: Store;
  /** Defaults to global fetch. Overridable in tests. */
  fetchFn?: typeof fetch;
  /** Defaults to the flow's pack login. Overridable in tests. */
  completeLogin?: ProviderOAuthFlow["completeLogin"];
}

export interface ProviderOAuthStatus {
  connected: boolean;
  email?: string;
  accountId?: string;
  expiresAt?: number;
}

function redirectUriFor(req: Request, fallbackPort: number, id: string): string {
  const port = req.socket.localPort || fallbackPort;
  return `http://localhost:${port}/api/oauth/${id}/callback`;
}

function oauthErrorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>LLMSwitch</title></head>
<body style="font-family:system-ui,sans-serif;background:#09090b;color:#e4e4e7;padding:2rem">
<h1>${title}</h1><p>${detail}</p><p><a href="/" style="color:#38bdf8">← Back to LLMSwitch dashboard</a></p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function registerProviderOAuthRoutes(app: Express, flow: ProviderOAuthFlow, deps: ProviderOAuthDeps): void {
  const { config, store } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const completeLogin = deps.completeLogin ?? flow.completeLogin;
  const states = new Map<string, StateEntry>();

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of states) if (v.expiresAt <= now) states.delete(k);
  };
  const consume = (state: string | undefined): StateEntry | null => {
    prune();
    if (!state) return null;
    const entry = states.get(state) ?? null;
    if (entry) states.delete(state); // single-use
    return entry;
  };

  // ---- Start: dashboard calls this, navigates the user to the returned URL ----
  app.get(`/api/oauth/${flow.id}/start`, (req: Request, res: Response) => {
    const redirectUri = redirectUriFor(req, config.port, flow.id);
    const state = randomBytes(16).toString("hex");
    const { codeVerifier, codeChallenge } = generatePkce();
    states.set(state, { expiresAt: Date.now() + STATE_TTL_MS, redirectUri, codeVerifier });
    res.json({ url: flow.buildAuthUrl(redirectUri, codeChallenge, state) });
  });

  // ---- Callback: public (state-protected); must never leak token values ----
  app.get(`/api/oauth/${flow.id}/callback`, async (req: Request, res: Response) => {
    const errParam = typeof req.query.error === "string" ? req.query.error : "";
    if (errParam) {
      res.status(400).send(oauthErrorPage(`${flow.displayName} sign-in failed`, `Provider returned: ${escapeHtml(errParam)}`));
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const entry = consume(typeof req.query.state === "string" ? req.query.state : undefined);
    if (!entry || !code) {
      res.status(400).send(oauthErrorPage("Invalid sign-in request", "Missing or expired state."));
      return;
    }
    try {
      const saved = await completeLogin(code, entry.redirectUri, entry.codeVerifier, fetchFn);
      store?.audit(`oauth.${flow.id}.connected`, saved.email ?? saved.accountId ?? flow.id, "browser flow");
      res.redirect(302, `/?oauth=${flow.id}`);
    } catch (err) {
      // Never echo token values or upstream bodies back to the browser.
      const message = err instanceof Error ? err.message : "unknown error";
      const safe = message.length > 160 ? message.slice(0, 160) + "…" : message;
      res.status(500).send(oauthErrorPage("Sign-in failed", escapeHtml(safe)));
    }
  });

  // ---- Status: metadata only, never token values ----
  app.get(`/api/oauth/${flow.id}/status`, (_req: Request, res: Response) => {
    const s = flow.loadSession();
    const status: ProviderOAuthStatus = s
      ? { connected: true, email: s.email, accountId: s.accountId, expiresAt: s.expiresAt }
      : { connected: false };
    res.json(status);
  });

  // ---- Disconnect ----
  app.post(`/api/oauth/${flow.id}/disconnect`, (_req: Request, res: Response) => {
    deleteSession(flow.sessionName);
    store?.audit(`oauth.${flow.id}.disconnected`, flow.id, "browser flow");
    res.json({ connected: false });
  });
}

/** Claude (Anthropic) OAuth flow bound to the web-session pack. */
export const CLAUDE_OAUTH_FLOW: ProviderOAuthFlow = {
  id: "claude",
  sessionName: "claude",
  displayName: "Claude",
  buildAuthUrl: buildClaudeAuthUrl,
  completeLogin: completeClaudeLoginWithCode,
  loadSession: loadClaudeSession,
};

/** Codex (OpenAI) OAuth flow bound to the web-session pack. */
export const CODEX_OAUTH_FLOW: ProviderOAuthFlow = {
  id: "codex",
  sessionName: "codex",
  displayName: "Codex",
  buildAuthUrl: buildCodexAuthUrl,
  completeLogin: completeCodexLoginWithCode,
  loadSession: loadCodexSession,
};
