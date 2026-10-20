import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Store } from "../store/db.js";

/**
 * Dashboard password login (OmniRoute-style).
 *
 * - A dashboard password always exists: until the owner changes it, the
 *   password is DEFAULT_DASHBOARD_PASSWORD (the login page shows it as a
 *   hint while it is still the default, per product decision).
 * - POST /api/auth/login verifies the password and issues an opaque session
 *   token (7-day TTL, in-memory — a gateway restart simply requires a new
 *   login). The dashboard sends it as `x-dashboard-session`.
 * - The /api gate (auth.ts) accepts a valid session token as an alternative
 *   to the ADMIN_KEY env secret. When neither ADMIN_KEY is set nor the
 *   password has been changed from the default, /api stays open for local
 *   DX (the pre-existing model); once the owner sets ADMIN_KEY or changes
 *   the dashboard password, /api requires admin key or session.
 */

export const DEFAULT_DASHBOARD_PASSWORD = "llmswitch";
const SETTING_KEY = "dashboard_pw_hash";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

export class DashboardSessions {
  constructor(private store: Store) {}

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  issue(): string {
    const token = randomBytes(32).toString("hex");
    this.store.createDashboardSession(this.hash(token), Date.now() + SESSION_TTL_MS);
    return token;
  }

  valid(token: string | undefined | null): boolean {
    if (!token) return false;
    const exp = this.store.dashboardSessionExpiry(this.hash(token));
    if (exp === null) return false;
    if (exp < Date.now()) {
      this.store.deleteDashboardSession(this.hash(token));
      return false;
    }
    return true;
  }

  revoke(token: string | undefined | null): void {
    if (token) this.store.deleteDashboardSession(this.hash(token));
  }

  revokeAll(): void {
    this.store.clearDashboardSessions();
  }
}

export function dashboardPasswordState(store: Store): { isDefault: boolean } {
  return { isDefault: !store.getSetting(SETTING_KEY) };
}

export function checkDashboardPassword(store: Store, password: string): boolean {
  const stored = store.getSetting(SETTING_KEY);
  if (!stored) return password === DEFAULT_DASHBOARD_PASSWORD;
  return verifyPassword(password, stored);
}

export function setDashboardPassword(store: Store, password: string): void {
  store.setSetting(SETTING_KEY, hashPassword(password));
}

/** Per-IP login throttle: max 10 attempts per minute. */
const loginHits = new Map<string, { count: number; resetAt: number }>();
function loginThrottled(ip: string): boolean {
  const now = Date.now();
  const rec = loginHits.get(ip);
  if (!rec || rec.resetAt < now) {
    loginHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  rec.count++;
  return rec.count > 10;
}

/**
 * Failure lockout (security hardening): 5 consecutive failed logins from
 * one IP lock it for 5 minutes; every further failure doubles the lock
 * (cap 1 hour). A successful login clears the record. This is what makes
 * an internet-facing default/weak password expensive to brute-force even
 * inside the per-minute throttle.
 */
const loginFailures = new Map<string, { fails: number; lockedUntil: number }>();
export function lockRemainingMs(ip: string, now = Date.now()): number {
  const rec = loginFailures.get(ip);
  return rec ? Math.max(0, rec.lockedUntil - now) : 0;
}
export function noteLoginFailure(ip: string, now = Date.now()): void {
  const rec = loginFailures.get(ip) ?? { fails: 0, lockedUntil: 0 };
  rec.fails++;
  if (rec.fails >= 5) {
    const over = rec.fails - 5;
    rec.lockedUntil = now + Math.min(3600_000, 300_000 * Math.pow(2, over));
  }
  loginFailures.set(ip, rec);
}
export function noteLoginSuccess(ip: string): void {
  loginFailures.delete(ip);
}

export function registerDashboardAuthRoutes(app: Express, store: Store, sessions: DashboardSessions): void {
  app.get("/api/auth/status", (_req: Request, res: Response) => {
    res.json({ required: true, isDefault: dashboardPasswordState(store).isDefault });
  });

  app.post("/api/auth/login", (req: Request, res: Response) => {
    const ip = req.ip ?? "unknown";
    const lockedMs = lockRemainingMs(ip);
    if (lockedMs > 0) {
      res.status(429).json({
        error: {
          message: `too many failed logins — this address is locked for ${Math.ceil(lockedMs / 1000)} more seconds`,
          type: "rate_limited",
        },
      });
      return;
    }
    if (loginThrottled(ip)) {
      res.status(429).json({ error: { message: "too many login attempts — try again in a minute", type: "rate_limited" } });
      return;
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!checkDashboardPassword(store, password)) {
      noteLoginFailure(ip);
      const nowLocked = lockRemainingMs(ip);
      store.audit("auth.login_failed", null, `ip=${ip}${nowLocked > 0 ? " (locked)" : ""}`);
      res.status(401).json({ error: { message: "wrong password", type: "auth_error" } });
      return;
    }
    noteLoginSuccess(ip);
    const token = sessions.issue();
    store.audit("auth.login", null, "dashboard login");
    res.json({ token, isDefault: dashboardPasswordState(store).isDefault });
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    sessions.revoke(req.header("x-dashboard-session"));
    res.json({ ok: true });
  });

  app.get("/api/auth/me", (req: Request, res: Response) => {
    if (sessions.valid(req.header("x-dashboard-session"))) {
      res.json({ ok: true, isDefault: dashboardPasswordState(store).isDefault });
      return;
    }
    res.status(401).json({ error: { message: "not logged in", type: "auth_error" } });
  });

  app.post("/api/auth/change-password", (req: Request, res: Response) => {
    // Caller must already be authenticated for /api (admin key or session) —
    // enforced by the auth middleware; here we additionally require the
    // current dashboard password.
    const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const next = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (next.length < 8) {
      res.status(400).json({ error: { message: "new password must be at least 8 characters", type: "bad_request" } });
      return;
    }
    if (!checkDashboardPassword(store, current)) {
      res.status(401).json({ error: { message: "current password is wrong", type: "auth_error" } });
      return;
    }
    setDashboardPassword(store, next);
    sessions.revokeAll();
    const token = sessions.issue();
    store.audit("auth.password_change", null, "dashboard password changed");
    res.json({ ok: true, token });
  });
}
