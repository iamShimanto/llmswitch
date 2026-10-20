import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { DeviceFlowClient } from "../src/deviceFlow.js";

describe("DeviceFlowClient (RFC 8628, mock IdP)", () => {
  let server: http.Server;
  let base: string;
  let polls = 0;
  let mode: "approve-after-2" | "deny" | "slow" | "never" = "approve-after-2";

  afterEach(() => {
    server?.close();
    polls = 0;
    mode = "approve-after-2";
  });

  async function start() {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url === "/device/code") {
          return res.end(
            JSON.stringify({
              device_code: "dev123",
              user_code: "ABCD-1234",
              verification_uri: `${base}/activate`,
              expires_in: 900,
              interval: 1,
            }),
          );
        }
        if (req.url === "/token") {
          polls++;
          if (mode === "never") {
            return res.end(JSON.stringify({ error: "authorization_pending" }));
          }
          if (mode === "deny" && polls >= 1) {
            return res.end(JSON.stringify({ error: "access_denied" }));
          }
          if (mode === "slow" && polls === 1) {
            return res.end(JSON.stringify({ error: "slow_down" }));
          }
          if (polls < 2) {
            return res.end(JSON.stringify({ error: "authorization_pending" }));
          }
          return res.end(
            JSON.stringify({ access_token: "tok_abc", token_type: "bearer", expires_in: 3600 }),
          );
        }
        res.writeHead(404);
        res.end("{}");
      });
    });
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        r();
      }),
    );
  }

  function client() {
    return new DeviceFlowClient({
      deviceAuthUrl: `${base}/device/code`,
      tokenUrl: `${base}/token`,
      clientId: "test-client",
    });
  }

  it("start() returns device + user codes", async () => {
    await start();
    const d = await client().start();
    expect(d.device_code).toBe("dev123");
    expect(d.user_code).toBe("ABCD-1234");
    expect(d.verification_uri).toContain("/activate");
  });

  it("poll() survives authorization_pending then returns tokens", async () => {
    await start();
    const t = await client().poll("dev123", { intervalSec: 0.05, timeoutMs: 10_000 });
    expect(t.access_token).toBe("tok_abc");
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("poll() backs off on slow_down", async () => {
    await start();
    mode = "slow";
    const t = await client().poll("dev123", { intervalSec: 0.05, timeoutMs: 10_000 });
    expect(t.access_token).toBe("tok_abc");
  }, 15_000);

  it("poll() throws on access_denied", async () => {
    await start();
    mode = "deny";
    await expect(client().poll("dev123", { intervalSec: 0.05, timeoutMs: 10_000 })).rejects.toThrow(
      /denied/,
    );
  });

  it("poll() times out", async () => {
    await start();
    mode = "never";
    await expect(
      client().poll("dev123", { intervalSec: 0.05, timeoutMs: 150 }),
    ).rejects.toThrow(/timed out/);
  });
});
