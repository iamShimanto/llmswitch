/**
 * Muse Spark Web driver — mock-tested: GraphQL warmup/mode POSTs, WS
 * frames, full/patch delta assembly, token handling. The live protocol
 * needs real meta.ai cookies (NEEDS LIVE VERIFICATION).
 */
import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { MuseSparkWebDriver } from "../src/providers/webchat/museSpark.js";
import { WebChatError } from "../src/providers/webchat/types.js";
import { parseProtoFields } from "../src/providers/webchat/museFrame.js";

function jarWithSession(): CookieJar {
  const jar = new CookieJar();
  jar.load("ecto_1_sess=abc123; datr=xyz", "meta.ai");
  return jar;
}

function okJsonFetch(calls: { url: string; body: string }[]): typeof fetch {
  return (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

interface FakeWsHandlers {
  onopen?: () => void;
  onmessage?: (e: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
}

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.last = this;
    setTimeout(() => {
      this.onopen?.();
      const full = JSON.stringify({
        type: "full",
        response: { sections: [{ view_model: { primitive: { text: "Hello" } } }] },
      });
      const patch = JSON.stringify({
        type: "patch",
        operations: [
          { op: "delta", path: "/sections/0/view_model/primitive/text", value: " world" },
        ],
      });
      this.onmessage?.({ data: full });
      this.onmessage?.({ data: patch });
      this.onclose?.();
    }, 5);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {}
}

describe("MuseSparkWebDriver", () => {
  it("bootstraps with an ecto_1_sess cookie and rejects its absence", async () => {
    const d = new MuseSparkWebDriver(jarWithSession(), okJsonFetch([]), {
      accessToken: "ecto1:tok",
      wsCtor: FakeWebSocket,
    });
    await expect(d.bootstrap()).resolves.toBeUndefined();

    const empty = new MuseSparkWebDriver(new CookieJar(), okJsonFetch([]), {});
    await expect(empty.bootstrap()).rejects.toBeInstanceOf(WebChatError);
  });

  it("runs warmup + mode switch, sends WS frames, assembles full+patch text", async () => {
    const calls: { url: string; body: string }[] = [];
    const d = new MuseSparkWebDriver(jarWithSession(), okJsonFetch(calls), {
      accessToken: "ecto1:tok123",
      wsCtor: FakeWebSocket,
    });
    const text = await d.chat("muse-spark-thinking", [{ role: "user", content: "Say hello" }]);
    expect(text).toBe("Hello world");
    // GraphQL warmup + mode switch happened, mode = think_hard
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toContain("e7f802582dbfed8e181b012e010993eb");
    expect(calls[1]!.body).toContain("think_hard");
    // WS: intro + prompt frames, prompt frame parses as proto
    const ws = FakeWebSocket.last!;
    expect(ws.url).toContain("ecto1%3Atok123");
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]![0]).toBe(0x0f);
    expect(ws.sent[1]![0]).toBe(0x0d);
    // frame = 6-byte header + seq/flag + JSON{req-id, payload: base64(proto)}
    const outer = JSON.parse(new TextDecoder().decode(ws.sent[1]!.slice(8))) as { payload: string };
    const proto = Buffer.from(outer.payload, "base64");
    expect(() => parseProtoFields(new Uint8Array(proto))).not.toThrow();
    expect(proto.toString("latin1")).toContain("Say hello");
  });

  it("fails with reconnect guidance when no token is available", async () => {
    const blockedFetch = (async (url: string) => {
      if (String(url).includes("graphql")) {
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("challenge", { status: 403 });
    }) as typeof fetch;
    const d = new MuseSparkWebDriver(jarWithSession(), blockedFetch, { wsCtor: FakeWebSocket });
    await expect(d.chat("muse-spark", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /ecto1 access token/,
    );
  });
});
