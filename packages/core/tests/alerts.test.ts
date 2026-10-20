import http from "node:http";
import { describe, expect, it } from "vitest";
import { Alerter } from "../src/alerts/index.js";
import { Inspector, truncateMessages } from "../src/inspect/index.js";

describe("Alerter", () => {
  it("POSTs alert JSON to the webhook", async () => {
    const received: Array<{ url: string; body: any }> = [];
    const srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        received.push({ url: req.url!, body: JSON.parse(b) });
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as any).port;

    const a = new Alerter(`http://127.0.0.1:${port}/hook`);
    expect(a.enabled).toBe(true);
    const sent = await a.send({ type: "provider_down", severity: "critical", message: "x down" });
    expect(sent).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]!.body.type).toBe("provider_down");
    expect(received[0]!.body.source).toBe("llmswitch");
    srv.close();
  });

  it("dedupes repeat alerts within the window", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return new Response("ok");
    }) as typeof fetch;
    const a = new Alerter("http://example.com/hook", 60_000, fetchFn);
    expect(await a.send({ type: "provider_down", severity: "critical", message: "m" }, "down:x")).toBe(true);
    expect(await a.send({ type: "provider_down", severity: "critical", message: "m" }, "down:x")).toBe(false);
    expect(n).toBe(1);
  });

  it("disabled alerter sends nothing and never throws", async () => {
    const a = new Alerter(undefined);
    expect(a.enabled).toBe(false);
    expect(await a.send({ type: "budget_exceeded", severity: "warn", message: "m" })).toBe(false);
  });

  it("webhook failure is swallowed", async () => {
    const fetchFn = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const a = new Alerter("http://127.0.0.1:1/hook", 0, fetchFn);
    expect(await a.send({ type: "provider_down", severity: "critical", message: "m" })).toBe(false);
  });
});

describe("Inspector", () => {
  it("records, lists and gets entries", () => {
    const ins = new Inspector(10);
    const e = ins.record({
      keyId: null, provider: "groq", model: "m", strategy: "priority",
      status: "ok", latencyMs: 42, cached: false,
      promptTokens: 5, completionTokens: 3, costUsd: 0.0001,
      request: [{ role: "user", content: "hi" }],
      responsePreview: "hello",
    });
    expect(e.id).toBeTruthy();
    expect(ins.list()).toHaveLength(1);
    expect(ins.get(e.id)!.provider).toBe("groq");
    expect(ins.get("nope")).toBeUndefined();
  });

  it("caps entries (ring buffer)", () => {
    const ins = new Inspector(3);
    const base = {
      keyId: null, provider: "a", model: "m", strategy: "priority",
      status: "ok" as const, latencyMs: 1, cached: false,
      promptTokens: 0, completionTokens: 0, costUsd: 0,
      request: [], responsePreview: "",
    };
    for (let i = 0; i < 5; i++) ins.record({ ...base, provider: `p${i}` });
    const list = ins.list();
    expect(list).toHaveLength(3);
    expect(list[0]!.provider).toBe("p4"); // newest first
  });

  it("truncateMessages keeps last 6 and trims content", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({
      role: "user" as const,
      content: "x".repeat(600) + i,
    }));
    const out = truncateMessages(msgs);
    expect(out).toHaveLength(6);
    expect(out[0]!.content).toHaveLength(500);
  });
});
