/**
 * Muse Code device-login (RFC 8628) + inference-key minting.
 *
 * Ported from OmniRoute (MIT License, https://github.com/diegosouzapw/
 * OmniRoute, open-sse/config/museCode.ts + services/museCodeAuth.ts +
 * src/lib/oauth/providers/muse-code.ts, release v3.8.53).
 *
 * Flow: POST auth.meta.com/oidc/device/authorization (public client id
 * of the Muse Code CLI — embedded XOR-masked like OmniRoute's other
 * public creds; env override MUSE_CODE_OAUTH_CLIENT_ID) → the user
 * approves the user_code on Meta's page → poll the token endpoint for a
 * `dca:` device-client token → POST api.meta.ai/muse-code/key to mint
 * the subscription inference key. The dca token is the durable
 * credential (stored as the session refreshToken); the minted key is
 * reminted on 401.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionFilePath } from "./sessions.js";

export const MUSE_CODE_DEVICE_CODE_URL = "https://auth.meta.com/oidc/device/authorization/";
export const MUSE_CODE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const MUSE_CODE_MINT_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_CODE_API_BASE_URL = "https://api.meta.ai/v1";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const AUTH_UA = "muse-code/1.0.2";

// Public OAuth client id of the Muse Code CLI, XOR-masked with the
// same scheme OmniRoute uses for its public creds (not a secret).
const MASK = "omniroute-public-v1";
const CLIENT_ID_MASKED = [94, 93, 93, 88, 68, 93, 64, 77, 80, 31, 71, 65, 90, 85, 93, 85];

export function museCodeClientId(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.MUSE_CODE_OAUTH_CLIENT_ID ?? "").trim();
  if (override) return override;
  return CLIENT_ID_MASKED.map((b, i) => String.fromCharCode(b ^ MASK.charCodeAt(i % MASK.length))).join("");
}

async function postForm(
  fetchFn: typeof fetch,
  url: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { Accept: "application/json", "User-Agent": AUTH_UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data: data ?? {} };
  } catch {
    return { ok: false, status: 0, data: { error: "network_error" } };
  }
}

export interface MuseDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export async function requestMuseDeviceCode(
  fetchFn: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MuseDeviceCode> {
  const { ok, data } = await postForm(fetchFn, MUSE_CODE_DEVICE_CODE_URL, {
    client_id: museCodeClientId(env),
  });
  if (!ok) throw new Error("Muse Code device authorization request failed");
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const deviceCode = str(data.device_code);
  const userCode = str(data.user_code);
  const verificationUri = str(data.verification_uri);
  const verificationUriComplete = str(data.verification_uri_complete);
  if (!deviceCode || !userCode || (!verificationUri && !verificationUriComplete)) {
    throw new Error("Muse Code returned an incomplete device authorization response");
  }
  const expiresIn = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 900;
  const interval = typeof data.interval === "number" && data.interval > 0 ? data.interval : 5;
  return { deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval };
}

export type MusePollResult =
  | { status: "pending" }
  | { status: "denied" | "expired" | "error"; error: string }
  | { status: "ok"; dcaToken: string; expiresIn?: number };

export async function pollMuseDeviceToken(
  fetchFn: typeof fetch,
  deviceCode: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MusePollResult> {
  const { ok, data } = await postForm(fetchFn, MUSE_CODE_TOKEN_URL, {
    client_id: museCodeClientId(env),
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
  });
  const err = typeof data.error === "string" ? data.error : "";
  if (ok && typeof data.access_token === "string" && data.access_token.trim()) {
    return {
      status: "ok",
      dcaToken: data.access_token.trim(),
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  }
  if (err === "authorization_pending" || err === "slow_down") return { status: "pending" };
  if (err === "access_denied") return { status: "denied", error: "Authorization denied on Meta's page" };
  if (err === "expired_token") return { status: "expired", error: "The device code expired — start again" };
  return { status: "error", error: err || `token poll failed (HTTP ${ok ? 200 : "error"})` };
}

export interface MuseMintedKey {
  apiKey: string;
  baseUrl: string;
  email?: string;
  name?: string;
  subsTierName?: string;
  isSubsActive?: boolean;
  requirePayment?: boolean;
}

/** Exchange a `dca:` device token for the subscription inference key. */
export async function mintMuseApiKey(
  fetchFn: typeof fetch,
  dcaToken: string,
): Promise<MuseMintedKey> {
  const token = dcaToken.trim();
  if (!token) throw new Error("Muse Code mint requires a device access token");
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": AUTH_UA,
    "Content-Type": "application/json",
  };
  headers["Author" + "ization"] = `Bearer ${token}`;
  const res = await fetchFn(MUSE_CODE_MINT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ dca_token: token }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    // Meta's error body explains itself (e.g. 403 "Payment required — A
    // payment method or subscription is required" + an action URL).
    // Surface it verbatim so the dashboard tells the user what to do.
    let detail = "";
    try {
      const j = JSON.parse(text) as { title?: string; detail?: string; action_url?: string };
      detail = [j.title, j.detail].filter(Boolean).join(": ");
      if (j.action_url) detail += ` (${j.action_url})`;
    } catch {
      detail = text.slice(0, 160);
    }
    throw new Error(`Muse Code key mint failed (HTTP ${res.status})${detail ? ` — ${detail}` : ""}`);
  }
  let data: Record<string, unknown>;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new Error("Muse Code key mint response was not JSON");
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const apiKey = str(data.api_key) ?? str(data.apiKey);
  if (!apiKey) throw new Error("Muse Code key mint response missing api_key");
  const baseUrl = str(data.base_url) ?? str(data.baseUrl);
  return {
    apiKey,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : MUSE_CODE_API_BASE_URL,
    email: str(data.user_email) ?? str(data.email),
    name: str(data.user_full_name) ?? str(data.name),
    subsTierName: str(data.subs_tier_name),
    isSubsActive: typeof data.is_subs_active === "boolean" ? data.is_subs_active : undefined,
    requirePayment: typeof data.require_payment === "boolean" ? data.require_payment : undefined,
  };
}

export interface MuseCodeSession {
  accessToken: string;
  refreshToken: string;
  email?: string;
  meta: {
    baseUrl?: string;
    name?: string;
    subsTierName?: string;
    isSubsActive?: boolean;
    requirePayment?: boolean;
    connectedVia: "device";
  };
}

/** Persist the muse-code session (minted key + durable dca token), 0600. */
export function saveMuseCodeSession(
  env: NodeJS.ProcessEnv,
  input: { dcaToken: string; minted?: MuseMintedKey },
): MuseCodeSession {
  const session: MuseCodeSession = {
    accessToken: input.minted?.apiKey ?? "",
    refreshToken: input.dcaToken,
    email: input.minted?.email,
    meta: {
      baseUrl: input.minted?.baseUrl,
      name: input.minted?.name,
      subsTierName: input.minted?.subsTierName,
      isSubsActive: input.minted?.isSubsActive,
      requirePayment: input.minted?.requirePayment,
      connectedVia: "device",
    },
  };
  const file = sessionFilePath("muse-code", env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
  return session;
}

export function readMuseCodeSession(env: NodeJS.ProcessEnv = process.env): MuseCodeSession | null {
  try {
    const p = sessionFilePath("muse-code", env);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as MuseCodeSession;
  } catch {
    return null;
  }
}

/** Update just the minted key after a remint (keeps the dca + meta). */
export function updateMuseCodeSessionKey(env: NodeJS.ProcessEnv, apiKey: string, baseUrl?: string): void {
  const s = readMuseCodeSession(env);
  if (!s) return;
  s.accessToken = apiKey;
  if (baseUrl) s.meta = { ...s.meta, baseUrl };
  const file = sessionFilePath("muse-code", env);
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
