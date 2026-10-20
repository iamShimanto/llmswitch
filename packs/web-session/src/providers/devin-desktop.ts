/**
 * Devin Desktop — IMPORT-TOKEN provider (no OAuth flow exists upstream).
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/OmniRoute,
 * release v3.8.53) — `src/lib/oauth/providers/devin-desktop.ts`
 * (`DEVIN_DESKTOP_CONFIG`, flowType "import_token") and
 * `open-sse/config/providers/registry/devin-desktop/index.ts`.
 * Attribution retained per MIT.
 *
 * How it works upstream: the user copies the API/session token out of the
 * Devin Desktop app (the rebranded Windsurf client; upstream is still
 * https://server.codeium.com) and pastes it here. There is nothing to poll
 * or redirect — validation is shape-only.
 *
 * ⚠️ TRANSPORT NOTE: the chat transport upstream is a Connect-protobuf RPC
 * (`/exa.api_server_pb.ApiServerService/GetChatMessage`) — it is NOT
 * ported in this wave (see BUILD_STATUS P11-I). The import + session work
 * today; gateway calls to `devin-desktop:*` return a typed
 * "transport not implemented" error rather than a fake success.
 */
import { loadSession, saveSession, type SavedSession } from "../sessionStore.js";

export const DEVIN_DESKTOP_BASE_URL = "https://server.codeium.com";

/** Shape-only validation, mirroring OmniRoute's validateImportToken. */
export function validateImportToken(token: string): { valid: boolean; reason?: string } {
  const trimmed = (token ?? "").trim();
  if (!trimmed) return { valid: false, reason: "Token is empty" };
  if (trimmed.length < 16) return { valid: false, reason: "Token is too short" };
  return { valid: true };
}

/** Import (paste) a Devin Desktop token into the session store (0600). */
export function saveDevinDesktopToken(token: string): SavedSession {
  const check = validateImportToken(token);
  if (!check.valid) throw new Error(`devin-desktop import: ${check.reason}`);
  saveSession({
    name: "devin-desktop",
    kind: "oauth-refresh",
    provider: "devin-desktop",
    accessToken: token.trim(),
  });
  const saved = loadSession("devin-desktop");
  if (!saved) throw new Error("devin-desktop import: session save failed");
  return saved;
}

export function loadDevinDesktopSession(): SavedSession | null {
  return loadSession("devin-desktop");
}
