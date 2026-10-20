import type { NextFunction, Request, Response } from "express";
import type { Store, ApiKeyRecord } from "../store/db.js";
import { RateLimiter } from "../quota/limiter.js";

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
export function createAuth(store: Store, limiter: RateLimiter) {
  const adminKey = (process.env.ADMIN_KEY ?? "").trim();

  return (req: Request, res: Response, next: NextFunction) => {
    // management APIs: admin-gated when ADMIN_KEY is set
    if (req.path.startsWith("/api/")) {
      // Exception: the OAuth redirect targets cannot carry an admin key
      // (they are plain browser redirects from the provider's servers). They
      // are protected by a single-use random `state` with a short TTL instead.
      if (/^\/api\/oauth\/(antigravity|claude|codex)\/callback$/.test(req.path)) return next();
      if (adminKey) {
        const provided =
          req.header("x-admin-key")?.trim() ||
          (req.header("authorization")?.startsWith("Bearer ")
            ? req.header("authorization")!.slice(7).trim()
            : "");
        if (provided !== adminKey) {
          res.status(401).json({ error: { message: "admin key required", type: "auth_error" } });
          return;
        }
      }
      return next();
    }

    if (req.path === "/healthz" || !req.path.startsWith("/v1/")) return next();

    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
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
