import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/db.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { DEFAULT_DASHBOARD_PASSWORD } from "../src/ingress/dashboardAuth.js";
import type { ResolvedProvider } from "../src/providers/types.js";

/**
 * End-to-end smoke suite: boots the REAL gateway (Express app, SQLite
 * store, auth, router, cache, breaker, backups) against a stub upstream
 * and walks the critical user journeys over HTTP. If a deploy breaks
 * login, key creation, chat, caching, fail-fast or backups, this fails.
 */
describe("smoke e2e", () => {
  let upstream: Server;
  let server: Server;
  let store: Store;
  let dir: string;
  let port: number;
  let deadHits = 0;

  afterEach(async () => {
    server?.close();
    upstream?.close();
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    delete process.env.ADMIN_KEY;
  });

  it("login → key → chat → cache → breaker → backup, all over HTTP", async () => {
    // ---- stub upstream ----
    upstream = createHttpServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { model?: string };
        if (body.model === "dead-1") {
          deadHits++;
          res.writeHead(410, { "content-type": "text/plain" });
          res.end("model retired");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "smoke", model: body.model ?? "smoke-1",
            choices: [{ index: 0, message: { role: "assistant", content: "SMOKE-OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upPort = (upstream.address() as { port: number }).port;

    // ---- gateway ----
    process.env.ADMIN_KEY = "smoke-admin";
    dir = mkdtempSync(join(tmpdir(), "lsw-smoke-"));
    store = new Store(dir);
    const stub = {
      id: "stub", name: "Stub", baseUrl: `http://127.0.0.1:${upPort}/v1`,
      wireFormat: "openai", models: ["smoke-1", "dead-1"], defaultModel: "smoke-1",
      costTier: 3, apiKey: "stub-key",
    } as unknown as ResolvedProvider;
    // Minimal registry double: refreshProviders() re-resolves through it,
    // and /api/catalog reads defs from it — returning the stub both ways
    // keeps the in-place provider list identical to what we booted with.
    const fakeRegistry = {
      all: () => [
        {
          id: "stub", name: "Stub", baseUrl: stub.baseUrl, wireFormat: "openai",
          envKey: "STUB_API_KEY", models: ["smoke-1", "dead-1"], defaultModel: "smoke-1",
          costTier: 3, authType: "api-key",
        },
      ],
      connected: () => [stub],
    } as unknown as import("../src/providers/registry.js").ProviderRegistry;
    const { app } = createServer(loadConfig(), [stub], store, fakeRegistry);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const admin = { "x-admin-key": "smoke-admin", "content-type": "application/json" };

    // health + security headers
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    const cat = await fetch(`${base}/api/catalog`, { headers: admin });
    expect(cat.status).toBe(200);
    expect(cat.headers.get("x-frame-options")).toBe("DENY");
    expect(cat.headers.get("x-content-type-options")).toBe("nosniff");

    // login: wrong password rejected, default password issues a session
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "not-the-password" }),
    });
    expect(wrong.status).toBe(401);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: DEFAULT_DASHBOARD_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    expect(token.length).toBeGreaterThan(10);
    const me = await fetch(`${base}/api/auth/me`, { headers: { "x-dashboard-session": token } });
    expect(me.status).toBe(200);

    // gateway key
    const keyRes = await fetch(`${base}/api/keys`, {
      method: "POST", headers: admin, body: JSON.stringify({ name: "smoke-key" }),
    });
    expect(keyRes.status).toBe(200);
    const { key } = (await keyRes.json()) as { key: string };
    const auth = { authorization: `Bearer ${key}`, "content-type": "application/json" };

    // models list includes the stub model + auto
    const models = await fetch(`${base}/v1/models`, { headers: auth });
    expect(models.status).toBe(200);
    const modelIds = ((await models.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    expect(modelIds).toContain("stub:smoke-1");
    expect(modelIds).toContain("auto");

    // chat works; the identical repeat is a cache hit
    const chatBody = JSON.stringify({
      model: "stub:smoke-1",
      messages: [{ role: "user", content: "hello smoke" }],
    });
    const c1 = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: chatBody });
    expect(c1.status).toBe(200);
    const j1 = (await c1.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j1.choices[0]!.message.content).toBe("SMOKE-OK");
    const c2 = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: chatBody });
    expect(c2.status).toBe(200);
    const j2 = (await c2.json()) as { cached?: boolean };
    expect(j2.cached).toBe(true);

    // dead model: first call hits upstream (410), second fails FAST
    const deadBody = JSON.stringify({
      model: "stub:dead-1",
      messages: [{ role: "user", content: "hello" }],
    });
    const d1 = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: deadBody });
    expect(d1.status).toBe(502);
    expect(deadHits).toBe(1);
    const d2 = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: auth, body: deadBody });
    expect(d2.status).toBe(502);
    expect(deadHits).toBe(1); // breaker stopped the second upstream call
    const breakers = await fetch(`${base}/api/circuit-breakers`, { headers: admin });
    const bj = (await breakers.json()) as { breakers: Array<{ key: string; open: boolean }> };
    expect(bj.breakers.find((b) => b.key === "stub:dead-1")?.open).toBe(true);

    // backups: create → list → delete
    const bk = await fetch(`${base}/api/backups`, { method: "POST", headers: admin, body: "{}" });
    expect(bk.status).toBe(200);
    const bkName = ((await bk.json()) as { backup: { name: string } }).backup.name;
    const list = await fetch(`${base}/api/backups`, { headers: admin });
    const lj = (await list.json()) as { backups: Array<{ name: string }> };
    expect(lj.backups.some((b) => b.name === bkName)).toBe(true);
    const del = await fetch(`${base}/api/backups/${encodeURIComponent(bkName)}`, {
      method: "DELETE", headers: admin,
    });
    expect(del.status).toBe(200);

    // quotas endpoint shape
    const quotas = await fetch(`${base}/api/quotas`, { headers: admin });
    expect(quotas.status).toBe(200);
    const qj = (await quotas.json()) as { providers: unknown[] };
    expect(Array.isArray(qj.providers)).toBe(true);
  }, 60_000);
});
