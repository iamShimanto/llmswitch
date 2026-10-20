import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { Store } from "../src/store/db.js";
import { loadConfig } from "../src/config.js";
import { createAuth } from "../src/ingress/auth.js";
import { registerRoutes } from "../src/ingress/routes.js";
import { Alerter } from "../src/alerts/index.js";
import { PromptCache } from "../src/cache/index.js";
import { RateLimiter } from "../src/quota/limiter.js";
import { Inspector } from "../src/inspect/index.js";
import { RoutingEventLog } from "../src/router/events.js";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_ACCESS = "AT-PKCE-12345";
const FAKE_REFRESH = "RT-PKCE-67890";

function fakeIdToken(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${seg({ alg: "none" })}.${seg(claims)}.sig`;
}

/** Mock token endpoints for Claude + Codex; records exchange forms per provider. */
function makeMockFetch() {
  const forms = new Map<string, URLSearchParams>();
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://api.anthropic.com/v1/oauth/token") {
      forms.set("claude", new URLSearchParams(String(init?.body ?? "")));
      return json({ access_token: FAKE_ACCESS, refresh_token: FAKE_REFRESH, expires_in: 3600 });
    }
    if (url === "https://auth.openai.com/oauth/token") {
      forms.set("codex", new URLSearchParams(String(init?.body ?? "")));
      return json({
        access_token: FAKE_ACCESS,
        refresh_token: FAKE_REFRESH,
        id_token: fakeIdToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test-1" } }),
        expires_in: 3600,
      });
    }
    return json({ error: "unexpected" }, 404);
  }) as typeof fetch;
  return { fn, forms };
}

async function boot(adminKey?: string) {
  process.env.ADMIN_KEY = adminKey ?? "";
  const sessDir = mkdtempSync(join(tmpdir(), "lsw-sess-"));
  process.env.LLMSWITCH_SESSIONS_DIR = sessDir;
  const config = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), "lsw-oauth-pkce-"));
  const store = new Store(dir);
  const { fn: mockFetch, forms } = makeMockFetch();
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(createAuth(store, new RateLimiter(600)));
  registerRoutes(app, {
    config,
    providers: [],
    store,
    router: undefined as never,
    cache: new PromptCache(),
    alerter: new Alerter(),
    inspector: new Inspector(),
    routingLog: new RoutingEventLog(),
    fetchFn: mockFetch,
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { store, server, dir, sessDir, port: (server.address() as { port: number }).port, forms };
}

const PROVIDERS = [
  {
    id: "claude",
    label: "Claude",
    authOrigin: "https://claude.ai",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  },
  {
    id: "codex",
    label: "Codex",
    authOrigin: "https://auth.openai.com",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  },
] as const;

describe.each(PROVIDERS)("$label browser OAuth (PKCE)", ({ id, authOrigin, clientId }) => {
  let s: Awaited<ReturnType<typeof boot>>;
  const adminHeaders = { "x-admin-key": "adm" };

  beforeEach(async () => {
    s = await boot("adm");
  });
  afterEach(() => {
    s.server.close();
    s.store.close();
    rmSync(s.dir, { recursive: true, force: true });
    rmSync(s.sessDir, { recursive: true, force: true });
    delete process.env.ADMIN_KEY;
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  const start = async (headers: Record<string, string> = adminHeaders) => {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/start`, { headers });
    return { r, j: (await r.json().catch(() => ({}))) as { url?: string } };
  };

  it("start requires the admin key", async () => {
    const { r } = await start({});
    expect(r.status).toBe(401);
  });

  it("start returns a PKCE consent URL", async () => {
    const { r, j } = await start();
    expect(r.status).toBe(200);
    const u = new URL(j.url!);
    expect(u.origin).toBe(authOrigin);
    expect(u.searchParams.get("client_id")).toBe(clientId);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(u.searchParams.get("redirect_uri")).toBe(`http://localhost:${s.port}/api/oauth/${id}/callback`);
    // PKCE flow: no client_secret is ever exposed
    expect(u.searchParams.get("client_secret")).toBeNull();
  });

  it("callback rejects a bad state with 400 and saves nothing", async () => {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/callback?code=x&state=nope`);
    expect(r.status).toBe(400);
    expect(existsSync(join(s.sessDir, `${id}.json`))).toBe(false);
  });

  it("callback works without the admin key, exchanges with the PKCE verifier, saves a 0600 session", async () => {
    const { j } = await start();
    const u = new URL(j.url!);
    const state = u.searchParams.get("state")!;
    const challenge = u.searchParams.get("code_challenge")!;
    // no admin headers — the provider redirect cannot carry them
    const r = await fetch(
      `http://127.0.0.1:${s.port}/api/oauth/${id}/callback?code=authcode1&state=${state}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/?oauth=${id}`);
    // the exchange used the verifier bound to this state (S256 of it matches the challenge)
    const form = s.forms.get(id)!;
    const { createHash } = await import("node:crypto");
    const verifier = form.get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBeNull();
    // session file: 0600, holds the mock tokens
    const p = join(s.sessDir, `${id}.json`);
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(p, "utf8"));
    expect(saved.accessToken).toBe(FAKE_ACCESS);
  });

  it("state is single-use: replaying the callback fails", async () => {
    const { j } = await start();
    const state = new URL(j.url!).searchParams.get("state")!;
    const url = `http://127.0.0.1:${s.port}/api/oauth/${id}/callback?code=c1&state=${state}`;
    const first = await fetch(url, { redirect: "manual" });
    expect(first.status).toBe(302);
    const second = await fetch(url, { redirect: "manual" });
    expect(second.status).toBe(400);
  });

  it("status reports metadata only — never token values", async () => {
    const { j } = await start();
    const state = new URL(j.url!).searchParams.get("state")!;
    await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/callback?code=c1&state=${state}`, {
      redirect: "manual",
    });
    const r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/status`, { headers: adminHeaders });
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = JSON.parse(text) as { connected: boolean };
    expect(body.connected).toBe(true);
    expect(text).not.toContain(FAKE_ACCESS);
    expect(text).not.toContain(FAKE_REFRESH);
  });

  it("disconnect removes the session", async () => {
    const { j } = await start();
    const state = new URL(j.url!).searchParams.get("state")!;
    await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/callback?code=c1&state=${state}`, {
      redirect: "manual",
    });
    const r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/disconnect`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect(r.status).toBe(200);
    expect(existsSync(join(s.sessDir, `${id}.json`))).toBe(false);
    const st = await fetch(`http://127.0.0.1:${s.port}/api/oauth/${id}/status`, { headers: adminHeaders });
    expect(((await st.json()) as { connected: boolean }).connected).toBe(false);
  });
});
