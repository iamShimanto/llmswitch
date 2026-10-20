import { type Request, type Response, type Express } from "express";
import { randomBytes } from "node:crypto";
import {
  ANTIGRAVITY_SESSION_NAME,
  buildAuthUrl,
  completeLoginWithCode,
  deleteSession,
  loadAntigravitySession,
  type SavedSession,
} from "@llmswitch/web-session";
import type { AppConfig } from "../config.js";
import type { Store } from "../store/db.js";

/**
 * Browser-based OAuth login for Antigravity (Google sign-in).
 *
 * Flow: dashboard "Connect" → GET /api/oauth/antigravity/start (admin-gated)
 * returns the Google consent URL → user signs in → Google redirects to
 * /api/oauth/antigravity/callback?code=&state= → code exchanged server-side,
 * loadCodeAssist/onboardUser assigns the Cloud Code project, tokens saved to
 * ~/.llmswitch/sessions/antigravity.json (0600) → 302 back to the dashboard.
 *
 * The callback is NOT admin-gated (a browser redirect from Google cannot carry
 * the admin key); it is protected by a single-use random `state` value with a
 * 10-minute TTL. Token values are never returned by any of these endpoints.
 *
 * Scopes are the standard Cloud Code set (see the web-session pack) and need
 * live verification against Google — the whole flow is mock-tested only.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

interface StateEntry {
  expiresAt: number;
  redirectUri: string;
}

export interface AntigravityOAuthDeps {
  config: AppConfig;
  store?: Store;
  /** Defaults to global fetch. Overridable in tests to mock Google. */
  fetchFn?: typeof fetch;
  /** Defaults to the pack's exchange+bootstrap+save. Overridable in tests. */
  completeLogin?: (code: string, redirectUri: string, fetchFn: typeof fetch) => Promise<SavedSession>;
  /** Called after connect/disconnect so the gateway re-resolves providers without a restart. */
  onCredentialsChanged?: () => void;
}

export interface OAuthStatus {
  connected: boolean;
  email?: string;
  projectId?: string;
  expiresAt?: number;
}

function redirectUriFor(req: Request, fallbackPort: number): string {
  const port = req.socket.localPort || fallbackPort;
  return `http://localhost:${port}/api/oauth/antigravity/callback`;
}

function oauthErrorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>LLMSwitch</title></head>
<body style="font-family:system-ui,sans-serif;background:#09090b;color:#e4e4e7;padding:2rem">
<h1>${title}</h1><p>${detail}</p><p><a href="/" style="color:#38bdf8">← Back to LLMSwitch dashboard</a></p>
</body></html>`;
}

export function registerAntigravityOAuthRoutes(app: Express, deps: AntigravityOAuthDeps): void {
  const { config, store } = deps;
  const fetchFn = deps.fetchFn ?? fetch;
  const completeLogin = deps.completeLogin ?? completeLoginWithCode;
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
  app.get("/api/oauth/antigravity/start", (req: Request, res: Response) => {
    const redirectUri = redirectUriFor(req, config.port);
    const state = randomBytes(16).toString("hex");
    states.set(state, { expiresAt: Date.now() + STATE_TTL_MS, redirectUri });
    res.json({ url: buildAuthUrl(redirectUri, state) });
  });

  // ---- Callback: public (state-protected); must never leak token values ----
  app.get("/api/oauth/antigravity/callback", async (req: Request, res: Response) => {
    const errParam = typeof req.query.error === "string" ? req.query.error : "";
    if (errParam) {
      res.status(400).send(oauthErrorPage("Google sign-in failed", `Google returned: ${escapeHtml(errParam)}`));
      return;
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const entry = consume(typeof req.query.state === "string" ? req.query.state : undefined);
    if (!entry || !code) {
      res.status(400).send(oauthErrorPage("Invalid sign-in request", "Missing or expired state."));
      return;
    }
    try {
      const saved = await completeLogin(code, entry.redirectUri, fetchFn);
      store?.audit("oauth.antigravity.connected", saved.email ?? saved.provider ?? "antigravity", "browser flow");
      deps.onCredentialsChanged?.();
      res.redirect(302, "/?oauth=antigravity");
    } catch (err) {
      // Never echo token values or upstream bodies back to the browser.
      const message = err instanceof Error ? err.message : "unknown error";
      const safe = message.length > 160 ? message.slice(0, 160) + "…" : message;
      res.status(500).send(oauthErrorPage("Sign-in failed", escapeHtml(safe)));
    }
  });

  // ---- Status: metadata only, never token values ----
  app.get("/api/oauth/antigravity/status", (_req: Request, res: Response) => {
    const s = loadAntigravitySession();
    const status: OAuthStatus = s
      ? { connected: true, email: s.email, projectId: s.projectId, expiresAt: s.expiresAt }
      : { connected: false };
    res.json(status);
  });

  // ---- Disconnect ----
  app.post("/api/oauth/antigravity/disconnect", (_req: Request, res: Response) => {
    deleteSession(ANTIGRAVITY_SESSION_NAME);
    deps.onCredentialsChanged?.();
    store?.audit("oauth.antigravity.disconnected", "antigravity", "browser flow");
    res.json({ connected: false });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
