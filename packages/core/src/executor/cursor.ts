/**
 * Cursor IDE — credential resolution for the deep-control/import flows.
 *
 * Login + refresh live in the web-session pack
 * (`packs/web-session/src/providers/cursor.ts`); this module mirrors its
 * session-file convention so the gateway can resolve tokens at call time
 * without depending on the pack (the same split as antigravity).
 *
 * ⚠️ CHAT WIRE NOT PORTED. Cursor's chat upstream is a protobuf
 * Connect-RPC service (OmniRoute `open-sse/executors/cursor.ts` is 1,856
 * lines + a cursor/ protobuf helper dir — StreamUnifiedChatWithTools on
 * api2.cursor.sh). Porting that wire is out of scope here; chat dispatch
 * raises a typed CursorWireError with the honest reason. Login, import,
 * refresh, and catalog are fully implemented.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionRequest, ResolvedProvider } from "../providers/types.js";
import { UpstreamError } from "../router/errors.js";
import type { ExecuteResult } from "./http.js";

export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

function sessionPath(env: NodeJS.ProcessEnv, accountId?: string | null): string {
  const dir = env.LLMSWITCH_SESSIONS_DIR ?? (env.DATA_DIR ? join(env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  return join(dir, accountId ? `cursor--${accountId}.json` : "cursor.json");
}

export interface CursorCreds {
  accessToken: string;
  refreshToken?: string;
  machineId?: string;
  email?: string;
}

/** True when a Cursor token is configured (env or saved session). */
export function hasCursorCreds(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.CURSOR_ACCESS_TOKEN ?? "").trim()) return true;
  if ((env.CURSOR_OAUTH_REFRESH_TOKEN ?? "").trim()) return true;
  return existsSync(sessionPath(env));
}

function readStoredSession(env: NodeJS.ProcessEnv, accountId?: string | null): {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  meta?: { machineId?: string; authMethod?: string };
} | null {
  try {
    const p = sessionPath(env, accountId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Resolve a usable access token: fresh session token, else refresh-token grant. */
export async function resolveCursorCreds(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
  accountId?: string | null,
): Promise<CursorCreds> {
  const envAccess = (env.CURSOR_ACCESS_TOKEN ?? "").trim();
  if (envAccess && !accountId) return { accessToken: envAccess, machineId: (env.CURSOR_MACHINE_ID ?? "").trim() || undefined };

  const stored = readStoredSession(env, accountId);
  const refreshToken = (env.CURSOR_OAUTH_REFRESH_TOKEN ?? "").trim() || stored?.refreshToken;
  if (stored?.accessToken && (!stored.expiresAt || stored.expiresAt > Date.now() + 60_000)) {
    return {
      accessToken: stored.accessToken,
      refreshToken,
      machineId: stored.meta?.machineId,
      email: stored.email,
    };
  }
  if (!refreshToken) {
    throw new UpstreamError(
      "auth_error",
      401,
      "cursor: no session — run: llmswitch login cursor (or llmswitch import-token cursor <accessToken> <refreshToken>)",
    );
  }
  const res = await fetchFn(CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${refreshToken}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new UpstreamError(
      "auth_error",
      res.status,
      `cursor token refresh failed: HTTP ${res.status} — re-run: llmswitch login cursor`,
    );
  }
  const j = (await res.json().catch(() => null)) as { accessToken?: string; refreshToken?: string; token?: string } | null;
  const accessToken = j?.accessToken ?? j?.token;
  if (!accessToken) throw new UpstreamError("auth_error", 401, "cursor token refresh: no access token in response");
  return { accessToken, refreshToken: j?.refreshToken ?? refreshToken, machineId: stored?.meta?.machineId, email: stored?.email };
}

/**
 * Typed error raised when a chat is dispatched to Cursor.
 * The chat wire (protobuf Connect-RPC StreamUnifiedChatWithTools) is not
 * ported — see the module header. Login/import/refresh/catalog ARE
 * implemented; only the final chat call is unavailable.
 */
export class CursorWireError extends UpstreamError {
  constructor() {
    super(
      "bad_request",
      501,
      "cursor: chat dispatch not implemented — Cursor's chat upstream is a protobuf " +
        "Connect-RPC service (not OpenAI/Anthropic/Gemini wire) and porting it needs the " +
        "full protobuf encoder (see OmniRoute open-sse/executors/cursor.ts). " +
        "Login/import/refresh (`llmswitch login cursor`) are implemented; chat calls return this error.",
    );
    this.name = "CursorWireError";
  }
}

/** Gateway path — resolves creds, then raises the honest wire error. */
export async function executeCursorChat(
  _provider: ResolvedProvider,
  _model: string,
  _body: ChatCompletionRequest,
  _fetchFn: typeof fetch = fetch,
  _timeoutMs = 120_000,
  _env: NodeJS.ProcessEnv = process.env,
  accountId?: string | null,
): Promise<ExecuteResult> {
  await resolveCursorCreds(_env, _fetchFn, accountId); // auth check first, so missing creds report as auth_error
  throw new CursorWireError();
}
