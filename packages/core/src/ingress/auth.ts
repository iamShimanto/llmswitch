import type { NextFunction, Request, Response } from "express";
import type { Store, ApiKeyRecord } from "../store/db.js";
import { RateLimiter } from "../quota/limiter.js";
import { dashboardPasswordState, type DashboardSessions } from "./dashboardAuth.js";

declare global {
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}

/**
 * Bearer auth middleware.
 * - /v1/* requires a gateway API key (per-key RPM limits).
 * - /api/* (management) is open by default for local DX, but when ADMIN_KEY is
 *   set it requires the admin key (x-admin-key header or Bearer).
 * - Everything else (dashboard assets, /healthz) is public.
 */
export function createAuth(store: Store, limiter: RateLimiter, sessions?: DashboardSessions) {
  const adminKey = (process.env.ADMIN_KEY ?? "").trim();

  return (req: Request, res: Response, next: NextFunction) => {
    // management APIs
    if (req.path.startsWith("/api/")) {
      // Exception: the OAuth redirect targets cannot carry an admin key
      // (they are plain browser redirects from the provider's servers). They
      // are protected by a single-use random `state` with a short TTL instead.
      if (/^\/api\/oauth\/(antigravity|claude|codex)\/callback$/.test(req.path)) return next();
      // Dashboard auth endpoints manage their own checks.
      if (req.path === "/api/auth/login" || req.path === "/api/auth/status") return next();
      // Protected when an ADMIN_KEY is set OR the dashboard password has
      // been changed from the default. Otherwise /api stays open (local DX).
      const isProtected = adminKey !== "" || !dashboardPasswordState(store).isDefault;
      if (!isProtected) return next();
      const provided =
        req.header("x-admin-key")?.trim() ||
        (req.header("authorization")?.startsWith("Bearer ")
          ? req.header("authorization")!.slice(7).trim()
          : "");
      if (adminKey && provided === adminKey) return next();
      if (sessions?.valid(req.header("x-dashboard-session"))) return next();
      res.status(401).json({ error: { message: "admin key or dashboard login required", type: "auth_error" } });
      return;
    }

    if (req.path === "/healthz" || !req.path.startsWith("/v1/")) return next();

    const header = req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    // Anthropic SDK / Claude Code send the key as x-api-key instead of Bearer.
    const token = bearer || (req.header("x-api-key")?.trim() ?? "");
    if (!token) {
      res.status(401).json({ error: { message: "missing bearer token", type: "auth_error" } });
      return;
    }
    const record = store.verifyApiKey(token);
    if (!record) {
      res.status(401).json({ error: { message: "invalid API key", type: "auth_error" } });
      return;
    }
    if (!limiter.allow(record.id)) {
      res.status(429).json({ error: { message: "rate limit exceeded for this key", type: "rate_limited" } });
      return;
    }
    req.apiKey = record;
    next();
  };
}
