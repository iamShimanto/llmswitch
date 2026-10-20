import { afterEach, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachWs } from "../src/ws/index.js";
import type { Router } from "../src/router/index.js";
import type { Store } from "../src/store/db.js";

function mockRouter(chunks: string[], nonStream?: string): Router {
  return {
    stats: new Map(),
    pools: new Map(),
    route: async () => {
      if (nonStream !== undefined) {
        return {
          response: {
            id: "x",
            model: "m",
            choices: [
              { index: 0, message: { role: "assistant", content: nonStream }, finish_reason: "stop" },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
          providerId: "mock-p",
          model: "m",
          latencyMs: 5,
        };
      }
      const gen = (async function* () {
        for (const c of chunks) yield { choices: [{ delta: { content: c } }] };
      })();
      return { stream: gen, providerId: "mock-p", model: "m", latencyMs: 5 };
    },
  } as unknown as Router;
}

const mockStore = {
  verifyApiKey: (k: string) => (k === "good-key" ? { id: "k1", name: "t" } : null),
} as unknown as Store;

describe("/v1/ws", () => {
  let http: HttpServer;
  let base: string;

  async function listen(router: Router) {
    http = createHttpServer();
    attachWs(http, { router, store: mockStore });
    await new Promise<void>((r) =>
      http.listen(0, "127.0.0.1", () => {
        base = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
        r();
      }),
    );
  }

  afterEach(() => {
    http?.close();
  });

  function collect(ws: WebSocket, ms = 3000): Promise<unknown[]> {
    const out: unknown[] = [];
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(out), ms);
      ws.on("message", (d) => {
        const m = JSON.parse(String(d)) as { type: string };
        out.push(m);
        if (m.type === "done" || m.type === "error") {
          clearTimeout(t);
          resolve(out);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  it("streams tokens then done (query-param auth)", async () => {
    await listen(mockRouter(["hel", "lo"]));
    const ws = new WebSocket(`${base}/v1/ws?key=good-key`);
    await new Promise<void>((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    ws.send(JSON.stringify({ type: "chat", model: "m", messages: [{ role: "user", content: "hi" }] }));
    const frames = (await collect(ws)) as Array<{ type: string; text?: string }>;
    ws.close();
    expect(frames.map((f) => f.type)).toEqual(["token", "token", "done"]);
    expect(frames.map((f) => f.text ?? "").join("")).toBe("hello");
    expect((frames[2] as { provider: string }).provider).toBe("mock-p");
  });

  it("accepts Bearer header auth", async () => {
    await listen(mockRouter(["x"]));
    const ws = new WebSocket(`${base}/v1/ws`, { headers: { authorization: "Bearer good-key" } });
    await new Promise<void>((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("rejects bad key with 401", async () => {
    await listen(mockRouter(["x"]));
    const ws = new WebSocket(`${base}/v1/ws?key=bad`);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => resolve(-1));
      setTimeout(() => resolve(-2), 3000);
    });
    expect(status).toBe(401);
  });

  it("sends error frame on invalid JSON", async () => {
    await listen(mockRouter(["x"]));
    const ws = new WebSocket(`${base}/v1/ws?key=good-key`);
    await new Promise<void>((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    ws.send("not json{{{");
    const frames = (await collect(ws)) as Array<{ type: string; message?: string }>;
    ws.close();
    expect(frames[0]?.type).toBe("error");
  });

  it("sends error frame on bad shape", async () => {
    await listen(mockRouter(["x"]));
    const ws = new WebSocket(`${base}/v1/ws?key=good-key`);
    await new Promise<void>((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    ws.send(JSON.stringify({ type: "ping" }));
    const frames = (await collect(ws)) as Array<{ type: string }>;
    ws.close();
    expect(frames[0]?.type).toBe("error");
  });

  it("non-stream route returns single token + done", async () => {
    await listen(mockRouter([], "full answer"));
    const ws = new WebSocket(`${base}/v1/ws?key=good-key`);
    await new Promise<void>((r, j) => {
      ws.on("open", r);
      ws.on("error", j);
    });
    ws.send(
      JSON.stringify({
        type: "chat",
        model: "m",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    );
    const frames = (await collect(ws)) as Array<{ type: string; text?: string }>;
    ws.close();
    expect(frames.map((f) => f.type)).toEqual(["token", "done"]);
    expect(frames[0]?.text).toBe("full answer");
  });
});
