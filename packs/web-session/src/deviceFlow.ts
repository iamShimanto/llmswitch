/**
 * RFC 8628 OAuth 2.0 Device Authorization Grant.
 * Generic client — works with any provider implementing the device flow
 * (GitHub, Google, Microsoft, …). The caller presents the user_code +
 * verification_uri to the user, then polls for tokens.
 */

export interface DeviceFlowConfig {
  /** e.g. https://github.com/login/device/code */
  deviceAuthUrl: string;
  /** e.g. https://github.com/login/oauth/access_token */
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
}

export interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export class DeviceFlowClient {
  constructor(
    private config: DeviceFlowConfig,
    private fetchFn: typeof fetch = fetch,
  ) {}

  /** Step 1: request device + user codes. Show user_code + verification_uri to the user. */
  async start(): Promise<DeviceAuthResponse> {
    const body = new URLSearchParams({ client_id: this.config.clientId });
    if (this.config.scope) body.set("scope", this.config.scope);
    const res = await this.fetchFn(this.config.deviceAuthUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`device auth failed: HTTP ${res.status}`);
    const j = (await res.json()) as Partial<DeviceAuthResponse>;
    if (!j.device_code || !j.user_code || !j.verification_uri) {
      throw new Error("device auth: malformed response");
    }
    return {
      device_code: j.device_code,
      user_code: j.user_code,
      verification_uri: j.verification_uri,
      verification_uri_complete: j.verification_uri_complete,
      expires_in: j.expires_in ?? 900,
      interval: j.interval ?? 5,
    };
  }

  /**
   * Step 2: poll the token endpoint until the user approves/denies or it times out.
   * Handles authorization_pending (keep polling) and slow_down (back off +5s).
   */
  async poll(
    deviceCode: string,
    opts: { intervalSec?: number; timeoutMs?: number } = {},
  ): Promise<DeviceTokenResponse> {
    let interval = Math.max(1, opts.intervalSec ?? 5);
    const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      if (Date.now() > deadline) throw new Error("device flow timed out waiting for user approval");
      await sleep(interval * 1000);
      const body = new URLSearchParams({
        client_id: this.config.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (this.config.clientSecret) body.set("client_secret", this.config.clientSecret);
      const res = await this.fetchFn(this.config.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        access_token?: string;
        token_type?: string;
        expires_in?: number;
        refresh_token?: string;
        scope?: string;
      };
      if (j.access_token) {
        return {
          access_token: j.access_token,
          token_type: j.token_type,
          expires_in: j.expires_in,
          refresh_token: j.refresh_token,
          scope: j.scope,
        };
      }
      if (j.error === "authorization_pending") continue;
      if (j.error === "slow_down") {
        interval += 5;
        continue;
      }
      if (j.error === "access_denied") throw new Error("device flow: user denied access");
      if (j.error === "expired_token") throw new Error("device flow: device code expired");
      throw new Error(`device flow failed: ${j.error ?? `HTTP ${res.status}`}`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
