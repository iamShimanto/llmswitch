/**
 * Session persistence for web-session packs.
 * Tokens/cookies live in ~/.llmswitch/sessions/<name>.json (0600).
 * The gateway never sees raw browser cookies — only what the user saved here.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SavedSession {
  name: string;
  kind: "oauth-device" | "oauth-refresh" | "cookies" | "token-import";
  provider?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  /** OAuth provider project id (e.g. Antigravity Cloud Code project) */
  projectId?: string;
  /** account email, display/derivation only */
  email?: string;
  /** OAuth provider account/workspace id (e.g. Codex chatgpt account id) */
  accountId?: string;
  /** GitHub Copilot: short-lived copilot token (exchanged from accessToken) */
  copilotToken?: string;
  /** GitHub Copilot: copilot token expiry, epoch ms */
  copilotTokenExpiresAt?: number;
  /** GitHub Copilot: per-account API host from the token exchange (endpoints.api) */
  copilotApiUrl?: string;
  /** GHE Copilot: GitHub Enterprise host, e.g. https://ghe.example.com */
  gheHost?: string;
  /** provider-specific extras (cursor machineId, kiro profileArn/client creds, trae identity fields, zed userId/systemId…) */
  meta?: Record<string, unknown>;
  cookies?: string;
  cookieDomain?: string;
  savedAt: number;
}

export function sessionsDir(): string {
  // Must match the core's resolution (LLMSWITCH_SESSIONS_DIR → DATA_DIR →
  // home). When these disagreed, OAuth sessions landed in the container's
  // home dir: the OAuth status (pack) saw them but the provider registry
  // (core, DATA_DIR) did not — providers showed connected on the OAuth card
  // yet never appeared in the provider list, and sessions died on rebuild.
  const dir =
    process.env.LLMSWITCH_SESSIONS_DIR ??
    (process.env.DATA_DIR ? join(process.env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pathFor(name: string): string {
  return join(sessionsDir(), `${name.replace(/[^a-z0-9-_]/gi, "_")}.json`);
}

export function saveSession(s: Omit<SavedSession, "savedAt">): string {
  const p = pathFor(s.name);
  writeFileSync(p, JSON.stringify({ ...s, savedAt: Date.now() }, null, 2));
  chmodSync(p, 0o600);
  return p;
}

export function loadSession(name: string): SavedSession | null {
  const p = pathFor(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SavedSession;
  } catch {
    return null;
  }
}

export function listSessions(): string[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

export function deleteSession(name: string): boolean {
  const p = pathFor(name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}
