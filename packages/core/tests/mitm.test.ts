import { describe, expect, it, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import { MitmProxy } from "../src/mitm/index.js";
import { registerMitmRoutes } from "../src/mitm/routes.js";
import { Inspector } from "../src/inspect/index.js";
import { memoryStore } from "../src/store/db.js";
import { createServer as createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import type { ResolvedProvider } from "../src/providers/types.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Mock upstream: records what it received, echoes JSON. */
async function mockUpstream() {
  const seen: { auth?: string; path?: string; body?: string; method?: string } = {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.auth = req.headers.authorization as string | undefined;
      seen.path = req.url;
      seen.body = body;
      seen.method = req.method;
      res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
      res.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { seen, port };
}

function fakeProvider(baseUrl: string): ResolvedProvider {
  return {
    id: "mockprov",
    name: "Mock Provider",
    baseUrl,
    wireFormat: "openai",
    models: ["m1"],
    defaultModel: "m1",
    costTier: 1,
    apiKey: "sk-secret-server-side-key",
  };
}

describe("MitmProxy", () => {
  it("forwards method/path/body, injects the server-side key, logs redacted", async () => {
    const up = await mockUpstream();
    const inspector = new Inspector();
    const mitm = new MitmProxy(inspector);
    const info = await mitm.start(fakeProvider(`http://127.0.0.1:${up.port}`), 0);
    expect(info.port).toBeGreaterThan(0);
    expect(info.providerId).toBe("mockprov");

    const res = await fetch(`http://127.0.0.1:${info.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer <redacted>", // must NOT reach upstream
        "x-custom": "hello",
      },
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean };
    expect(j.ok).toBe(true);
    expect(res.headers.get("x-upstream")).toBe("yes");

    // upstream got the server-side key, not the client's
    expect(up.seen.auth).toBe("Bearer sk-secret-server-side-key");
    expect(up.seen.path).toBe("/v1/chat/completions");
    expect(up.seen.method).toBe("POST");
    expect(up.seen.body).toContain('"model":"m1"');

    // log: client auth redacted, key never in log
    const log = mitm.getLog(info.id)!;
    expect(log).toHaveLength(1);
    const e = log[0]!;
    expect(e.method).toBe("POST");
    expect(e.path).toBe("/v1/chat/completions");
    expect(e.resStatus).toBe(200);
    expect(e.reqHeaders["authorization"]).toBe("[redacted]");
    expect(e.reqHeaders["x-custom"]).toBe("hello");
    expect(JSON.stringify(e)).not.toContain("sk-secret-server-side-key");
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
    expect(e.error).toBeNull();

    // mirrored into inspector ring buffer
    const insp = inspector.list();
    expect(insp.length).toBe(1);
    expect(insp[0]!.provider).toBe("mockprov");
    expect(insp[0]!.strategy).toBe("mitm");
    expect(insp[0]!.status).toBe("ok");

    expect(mitm.stop(info.id)).toBe(true);
    expect(mitm.stop(info.id)).toBe(false);
    expect(mitm.list()).toHaveLength(0);
    expect(mitm.getLog(info.id)).toBeUndefined();
  });

  it("rejects invalid ports and taken ports", async () => {
    const up = await mockUpstream();
    const mitm = new MitmProxy();
    await expect(mitm.start(fakeProvider(`http://127.0.0.1:${up.port}`), 99999)).rejects.toThrow();
    const a = await mitm.start(fakeProvider(`http://127.0.0.1:${up.port}`), 0);
    // same port taken
    await expect(mitm.start(fakeProvider(`http://127.0.0.1:${up.port}`), a.port)).rejects.toThrow();
    mitm.stop(a.id);
  });

  it("logs upstream errors without crashing", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const mitm = new MitmProxy();
    const info = await mitm.start(fakeProvider(`http://127.0.0.1:${port}`), 0);
    const res = await fetch(`http://127.0.0.1:${info.port}/x`);
    expect(res.status).toBe(500);
    const e = mitm.getLog(info.id)![0]!;
    expect(e.resStatus).toBe(500);
    expect(e.error).toBeNull();
    mitm.stop(info.id);
  });

  it("502s when upstream is unreachable", async () => {
    const mitm = new MitmProxy();
    // port 1 is (almost) certainly closed
    const info = await mitm.start(fakeProvider("http://127.0.0.1:1"), 0);
    const res = await fetch(`http://127.0.0.1:${info.port}/x`);
    expect(res.status).toBe(502);
    const e = mitm.getLog(info.id)![0]!;
    expect(e.error).toBeTruthy();
    mitm.stop(info.id);
  });
});

describe("mitm routes", () => {
  it("start → sessions → log → stop lifecycle, plus 404/400 paths", async () => {
    const app = express();
    app.use(express.json());
    const store = memoryStore();
    registerMitmRoutes(app, {
      providers: [fakeProvider("http://127.0.0.1:1")],
      inspector: new Inspector(),
      store,
    });
    const srv = app.listen(0, "127.0.0.1");
    servers.push(srv);
    await new Promise<void>((r) => srv.on("listening", r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // unknown provider → 404
    expect((await post("/api/mitm/start", { provider: "nope", port: 0 })).status).toBe(404);
    // bad port → 400
    expect((await post("/api/mitm/start", { provider: "mockprov", port: 99999 })).status).toBe(400);
    // bad body → 400
    expect((await post("/api/mitm/start", { provider: "mockprov" })).status).toBe(400);

    // happy path
    const started = await post("/api/mitm/start", { provider: "mockprov", port: 0 });
    expect(started.status).toBe(200);
    const info = (await started.json()) as { id: string; providerId: string; url: string; port: number };
    expect(info.providerId).toBe("mockprov");
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`);

    const sess = (await (await fetch(`${base}/api/mitm/sessions`)).json()) as {
      sessions: { id: string; providerId: string }[];
    };
    expect(sess.sessions).toHaveLength(1);
    expect(sess.sessions[0]!.id).toBe(info.id);

    const log = (await (await fetch(`${base}/api/mitm/${info.id}/log`)).json()) as {
      entries: unknown[];
    };
    expect(log.entries).toHaveLength(0);

    // unknown ids → 404
    expect((await fetch(`${base}/api/mitm/nope/log`)).status).toBe(404);
    expect((await post("/api/mitm/stop/nope", {})).status).toBe(404);

    const stopped = await post(`/api/mitm/stop/${info.id}`, {});
    expect(stopped.status).toBe(200);
    const sess2 = (await (await fetch(`${base}/api/mitm/sessions`)).json()) as {
      sessions: unknown[];
    };
    expect(sess2.sessions).toHaveLength(0);
  });

  it("is admin-gated through the real server when ADMIN_KEY is set", async () => {
    const prev = process.env.ADMIN_KEY;
    process.env.ADMIN_KEY = "s3cret-admin";
    try {
      const store = memoryStore();
      const { app } = createApp(loadConfig(), [], store);
      const srv = app.listen(0, "127.0.0.1");
      servers.push(srv);
      await new Promise<void>((r) => srv.on("listening", r));
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

      const anon = await fetch(`${base}/api/mitm/sessions`);
      expect(anon.status).toBe(401);
      const wrong = await fetch(`${base}/api/mitm/sessions`, {
        headers: { "x-admin-key": "nope" },
      });
      expect(wrong.status).toBe(401);
      const ok = await fetch(`${base}/api/mitm/sessions`, {
        headers: { "x-admin-key": "s3cret-admin" },
      });
      expect(ok.status).toBe(200);
      store.close();
    } finally {
      if (prev === undefined) delete process.env.ADMIN_KEY;
      else process.env.ADMIN_KEY = prev;
    }
  });
});
