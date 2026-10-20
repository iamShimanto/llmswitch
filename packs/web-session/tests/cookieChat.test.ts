import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "../src/cookieJar.js";
import { CookieChatDriver } from "../src/cookieChat.js";
import { saveSession, loadSession, listSessions, deleteSession } from "../src/sessionStore.js";

describe("CookieChatDriver (mock endpoint)", () => {
  let server: http.Server;
  let base: string;
  let seenCookie = "";
  afterEach(() => server?.close());

  async function start() {
    server = http.createServer((req, res) => {
      seenCookie = (req.headers.cookie as string) ?? "";
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "refreshed=1; Path=/",
        });
        res.end(JSON.stringify({ choices: [{ message: { content: "mock reply" } }] }));
      });
    });
    await new Promise<void>((r) =>
      server.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        r();
      }),
    );
  }

  it("sends cookies and parses the reply", async () => {
    await start();
    const jar = new CookieJar();
    jar.load("session=abc123", new URL(base).hostname);
    const d = new CookieChatDriver(jar, { url: `${base}/chat`, wireFormat: "openai" });
    const reply = await d.chat("any-model", [{ role: "user", content: "hi" }]);
    expect(reply).toBe("mock reply");
    expect(seenCookie).toContain("session=abc123");
    // refreshed cookies are harvested
    expect(jar.headerFor(`${base}/`)).toContain("refreshed=1");
  });

  it("throws without cookies", async () => {
    await start();
    const d = new CookieChatDriver(new CookieJar(), { url: `${base}/chat`, wireFormat: "openai" });
    await expect(d.chat("m", [{ role: "user", content: "hi" }])).rejects.toThrow(/no cookies/);
  });
});

describe("sessionStore", () => {
  it("saves, lists, loads and deletes", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    process.env.LLMSWITCH_SESSIONS_DIR = dir;
    try {
      saveSession({ name: "s1", kind: "cookies", cookies: "a=b", cookieDomain: "x.com" });
      saveSession({ name: "s2", kind: "oauth-device", accessToken: "t" });
      expect(listSessions().sort()).toEqual(["s1", "s2"]);
      const s1 = loadSession("s1")!;
      expect(s1.cookies).toBe("a=b");
      expect(s1.savedAt).toBeGreaterThan(0);
      expect(deleteSession("s1")).toBe(true);
      expect(loadSession("s1")).toBeNull();
      expect(listSessions()).toEqual(["s2"]);
    } finally {
      delete process.env.LLMSWITCH_SESSIONS_DIR;
    }
  });
});
