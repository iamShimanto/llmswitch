/**
 * ChatGPT Sentinel proof-of-work — best-effort headless implementation.
 *
 * The conversation endpoint expects anti-abuse headers minted by the
 * sentinel flow:
 *   1. POST /backend-api/sentinel/chat-requirements { p } where `p` is
 *      "gAAAAAC" + base64(JSON browser-config). The response carries a
 *      requirements `token` and, usually, a proof-of-work challenge
 *      { seed, difficulty }.
 *   2. The proof: find a nonce such that sha3-512(seed + base64(config
 *      with the nonce)) hex-prefix <= difficulty; the proof token is
 *      "gAAAAAB" + base64(config) + "~S".
 *   3. Both ride on the conversation POST as
 *      `openai-sentinel-chat-requirements-token` /
 *      `openai-sentinel-proof-token`.
 *
 * HONEST LIMITS: when ChatGPT additionally demands a Turnstile token
 * (response `turnstile.required`), no headless client can mint one —
 * that token comes from executing Cloudflare's challenge VM in a real
 * browser (which is why OmniRoute drives a browser for this provider).
 * In that case mintSentinelHeaders throws a clear, actionable error
 * instead of letting the turn die as an opaque 403. Datacenter IPs are
 * also challenged more aggressively than residential ones.
 */
import { createHash } from "node:crypto";
import { WebChatError } from "./types.js";

export const SENTINEL_REQUIREMENTS_URL =
  "https://chatgpt.com/backend-api/sentinel/chat-requirements";

const MAX_POW_ITERATIONS = 500_000;

/**
 * The browser-environment config array the sentinel SDK hashes. The
 * server verifies the PoW math against the payload AS SENT, so the
 * values need to be plausible, not literally true; the nonce slot
 * (index 3) and elapsed slot (index 9) are filled by the solver.
 */
export function buildSentinelConfig(userAgent: string, now = Date.now()): unknown[] {
  return [
    1920 + 1080,
    new Date(now).toString(),
    4294705152,
    0,
    userAgent,
    "https://chatgpt.com/backend-api/sentinel/sdk.js",
    null,
    "en-US",
    "en-US,en",
    0,
    "webdriver-false",
    "location",
    "chrome",
    now - 1234,
  ];
}

const b64json = (v: unknown): string => Buffer.from(JSON.stringify(v), "utf8").toString("base64");

/** The `p` payload sent to chat-requirements. */
export function requirementsPayload(config: unknown[]): string {
  return `gAAAAAC${b64json(config)}`;
}

/**
 * Solve a sentinel PoW challenge. Returns the proof token, or null when
 * no nonce satisfies the difficulty within the iteration budget.
 * Pure and deterministic for a given (seed, difficulty, config) triple.
 */
export function solveProofOfWork(
  seed: string,
  difficulty: string,
  baseConfig: unknown[],
  startedAt = Date.now(),
): string | null {
  const target = difficulty.toLowerCase();
  for (let i = 0; i < MAX_POW_ITERATIONS; i++) {
    const config = [...baseConfig];
    config[3] = i;
    config[9] = Math.max(0, Date.now() - startedAt);
    const encoded = b64json(config);
    const digest = createHash("sha3-512").update(seed + encoded, "utf8").digest("hex");
    if (digest.slice(0, target.length) <= target) {
      return `gAAAAAB${encoded}~S`;
    }
  }
  return null;
}

export interface SentinelRequirements {
  token?: string;
  proofofwork?: { required?: boolean; seed?: string; difficulty?: string };
  turnstile?: { required?: boolean };
}

/**
 * Run the sentinel flow and return the headers for the conversation
 * POST. Throws WebChatError with an actionable message when Turnstile
 * is demanded or the PoW cannot be solved; returns null when the
 * requirements endpoint itself is unreachable (caller falls back to the
 * previous no-headers behavior).
 */
export async function mintSentinelHeaders(opts: {
  providerId: string;
  fetchFn: typeof fetch;
  userAgent: string;
  accessToken?: string;
  cookie?: string;
}): Promise<Record<string, string> | null> {
  const config = buildSentinelConfig(opts.userAgent);
  let res: Response;
  try {
    res = await opts.fetchFn(SENTINEL_REQUIREMENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": opts.userAgent,
        ...(opts.accessToken ? { authorization: `Bearer ${opts.accessToken}` } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
      body: JSON.stringify({ p: requirementsPayload(config) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as SentinelRequirements | null;
  if (!data?.token) return null;

  if (data.turnstile?.required) {
    throw new WebChatError(
      opts.providerId,
      "chatgpt demands a Turnstile browser check for this session — a headless client cannot mint that token (OmniRoute drives a real browser for this provider). Alternatives: the OpenAI API-key provider, or the Codex OAuth provider.",
    );
  }

  const headers: Record<string, string> = {
    "openai-sentinel-chat-requirements-token": data.token,
  };
  const pow = data.proofofwork;
  if (pow?.required && pow.seed && pow.difficulty) {
    const proof = solveProofOfWork(pow.seed, pow.difficulty, config);
    if (!proof) {
      throw new WebChatError(
        opts.providerId,
        "chatgpt proof-of-work could not be solved within the iteration budget",
      );
    }
    headers["openai-sentinel-proof-token"] = proof;
  }
  return headers;
}
