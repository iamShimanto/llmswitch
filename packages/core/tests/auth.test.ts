import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { registry } from "../src/providers/registry.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { Server } from "node:http";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function boot(adminKey?: string) {
  process.env.ADMIN_KEY = adminKey ?? "";
  const config = loadConfig();
  const dir = mkdtempSync(join(tmpdir(), "lsw-auth-"));
  const store = new Store(dir);
  const { app } = createServer(config, [], store);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  return { store, server, dir, port: (server.address() as any).port };
}

describe("management API auth", () => {
  let s: Awaited<ReturnType<typeof boot>>;
  afterEach(() => {
    s.server.close();
    s.store.close();
    rmSync(s.dir, { recursive: true, force: true });
    delete process.env.ADMIN_KEY;
  });

  it("open when ADMIN_KEY unset", async () => {
    s = await boot();
    const r = await fetch(`http://127.0.0.1:${s.port}/api/providers`);
    expect(r.status).toBe(200);
  });

  it("401 without admin key when ADMIN_KEY set", async () => {
    s = await boot("secret123");
    const r = await fetch(`http://127.0.0.1:${s.port}/api/providers`);
    expect(r.status).toBe(401);
  });

  it("200 with x-admin-key header", async () => {
    s = await boot("secret123");
    const r = await fetch(`http://127.0.0.1:${s.port}/api/providers`, {
      headers: { "x-admin-key": "secret123" },
    });
    expect(r.status).toBe(200);
  });

  it("200 with Bearer admin key", async () => {
    s = await boot("secret123");
    const r = await fetch(`http://127.0.0.1:${s.port}/api/usage`, {
      headers: { authorization: "Bearer secret123" },
    });
    expect(r.status).toBe(200);
  });

  it("wrong admin key → 401", async () => {
    s = await boot("secret123");
    const r = await fetch(`http://127.0.0.1:${s.port}/api/providers`, {
      headers: { "x-admin-key": "nope" },
    });
    expect(r.status).toBe(401);
  });

  it("security headers present", async () => {
    s = await boot();
    const r = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("/v1/* still needs gateway API key", async () => {
    s = await boot("secret123");
    const r = await fetch(`http://127.0.0.1:${s.port}/v1/models`);
    expect(r.status).toBe(401);
  });
});
