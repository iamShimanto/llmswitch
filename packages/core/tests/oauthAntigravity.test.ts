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
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_ACCESS = "AT-TEST-12345";
const FAKE_REFRESH = "RT-TEST-67890";
const FAKE_PROJECT = "proj-test-42";
const FAKE_EMAIL = "dev@example.com";

/** Mock Google: token exchange + loadCodeAssist + userinfo, all else 404. */
const mockFetch = (async (input: unknown) => {
  const url = String(input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (url === "https://oauth2.googleapis.com/token") {
    return json({ access_token: FAKE_ACCESS, refresh_token: FAKE_REFRESH, expires_in: 3600 });
  }
  if (url.includes(":loadCodeAssist")) {
    return json({ cloudaicompanionProject: { id: FAKE_PROJECT }, currentTier: { id: "legacy-tier" } });
  }
  if (url.includes("userinfo")) {
    return json({ email: FAKE_EMAIL });
  }
  return json({ error: "unexpected" }, 404);
}) as typeof fetch;

async function bootWithMock(adminKey?: string) {
  process.env.ADMIN_KEY = adminKey ?? "";
  const sessDir = mkdtempSync(join(tmpdir(), "lsw-sess-"));
  process.env.LLMSWITCH_SESSIONS_DIR = sessDir;
  const config = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), "lsw-oauth-"));
  const store = new Store(dir);
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(createAuth(store, new RateLimiter(600)));
  registerRoutes(
    app,
    {
      config,
      providers: [],
      store,
      router: undefined as never,
      cache: new PromptCache(),
      alerter: new Alerter(),
      inspector: new Inspector(),
      routingLog: new RoutingEventLog(),
      fetchFn: mockFetch,
    },
  );
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { store, server, dir, sessDir, port: (server.address() as { port: number }).port };
}

describe("Antigravity browser OAuth", () => {
  let s: Awaited<ReturnType<typeof bootWithMock>>;
  const adminHeaders = { "x-admin-key": "adm" };

  beforeEach(async () => {
    s = await bootWithMock("adm");
  });
  afterEach(() => {
    s.server.close();
    s.store.close();
    rmSync(s.dir, { recursive: true, force: true });
    rmSync(s.sessDir, { recursive: true, force: true });
    delete process.env.ADMIN_KEY;
    delete process.env.LLMSWITCH_SESSIONS_DIR;
  });

  const startUrl = async (): Promise<{ url: string; state: string }> => {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/antigravity/start`, {
      headers: adminHeaders,
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { url: string };
    const u = new URL(j.url);
    return { url: j.url, state: u.searchParams.get("state") ?? "" };
  };

  it("start returns a well-formed Google auth URL", async () => {
    const { url, state } = await startUrl();
    const u = new URL(url);
    expect(u.origin).toBe("https://accounts.google.com");
    expect(u.pathname).toBe("/o/oauth2/auth");
    expect(u.searchParams.get("client_id")).toBeTruthy();
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(u.searchParams.get("redirect_uri")).toBe(
      `http://localhost:${s.port}/api/oauth/antigravity/callback`,
    );
  });

  it("callback rejects a bad state with 400 and saves nothing", async () => {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/antigravity/callback?code=x&state=nope`);
    expect(r.status).toBe(400);
    expect(existsSync(join(s.sessDir, "antigravity.json"))).toBe(false);
  });

  it("callback rejects a missing code with 400", async () => {
    const { state } = await startUrl();
    const r = await fetch(
      `http://127.0.0.1:${s.port}/api/oauth/antigravity/callback?state=${state}`,
    );
    expect(r.status).toBe(400);
  });

  it("callback success: session saved (0600), 302, no token leak", async () => {
    const { state } = await startUrl();
    const r = await fetch(
      `http://127.0.0.1:${s.port}/api/oauth/antigravity/callback?code=AUTHCODE&state=${state}`,
      { redirect: "manual" },
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/?oauth=antigravity");

    // response must not contain token values
    const body = await r.text();
    expect(body).not.toContain(FAKE_ACCESS);
    expect(body).not.toContain(FAKE_REFRESH);

    // session file written with 0600, content intact
    const p = join(s.sessDir, "antigravity.json");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(readFileSync(p, "utf8"));
    expect(saved.accessToken).toBe(FAKE_ACCESS);
    expect(saved.refreshToken).toBe(FAKE_REFRESH);
    expect(saved.projectId).toBe(FAKE_PROJECT);
    expect(saved.email).toBe(FAKE_EMAIL);
  });

  it("state is single-use", async () => {
    const { state } = await startUrl();
    const first = await fetch(
      `http://127.0.0.1:${s.port}/api/oauth/antigravity/callback?code=A&state=${state}`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);
    const second = await fetch(
      `http://127.0.0.1:${s.port}/api/oauth/antigravity/callback?code=A&state=${state}`,
    );
    expect(second.status).toBe(400);
  });

  it("status reports metadata only, then disconnect clears it", async () => {
    let r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/antigravity/status`, {
      headers: adminHeaders,
    });
    expect((await r.json()) as { connected: boolean }).toEqual({ connected: false });

    const { state } = await startUrl();
    await fetch(
      `http://127.0.0.1:${s.port}/api/oauth/antigravity/callback?code=A&state=${state}`,
      { redirect: "manual" },
    );

    r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/antigravity/status`, {
      headers: adminHeaders,
    });
    const st = (await r.json()) as Record<string, unknown>;
    expect(st.connected).toBe(true);
    expect(st.email).toBe(FAKE_EMAIL);
    expect(st.projectId).toBe(FAKE_PROJECT);
    expect(typeof st.expiresAt).toBe("number");
    expect(st).not.toHaveProperty("accessToken");
    expect(st).not.toHaveProperty("refreshToken");

    r = await fetch(`http://127.0.0.1:${s.port}/api/oauth/antigravity/disconnect`, {
      method: "POST",
      headers: adminHeaders,
    });
    expect((await r.json()) as { connected: boolean }).toEqual({ connected: false });
    expect(existsSync(join(s.sessDir, "antigravity.json"))).toBe(false);
  });

  it("admin gating: start/status/disconnect 401 without key, callback open", async () => {
    const noKey = `http://127.0.0.1:${s.port}`;
    expect((await fetch(`${noKey}/api/oauth/antigravity/start`)).status).toBe(401);
    expect((await fetch(`${noKey}/api/oauth/antigravity/status`)).status).toBe(401);
    expect((await fetch(`${noKey}/api/oauth/antigravity/disconnect`, { method: "POST" })).status).toBe(
      401,
    );
    expect(
      (await fetch(`${noKey}/api/oauth/antigravity/start`, { headers: adminHeaders })).status,
    ).toBe(200);

    // callback works WITHOUT the admin key (state-protected)
    const { state } = await startUrl();
    const cb = await fetch(`${noKey}/api/oauth/antigravity/callback?code=A&state=${state}`, {
      redirect: "manual",
    });
    expect(cb.status).toBe(302);
  });
});
