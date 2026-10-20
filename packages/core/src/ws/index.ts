/**
 * Realtime websocket endpoint: GET /v1/ws
 *
 * Protocol (JSON frames):
 *   client → server: { type: "chat", model?: string, messages: [...], stream?: boolean }
 *   server → client: { type: "token", text: string }   (streamed chunks)
 *                     { type: "done", provider, model, latencyMs, cached }
 *                     { type: "error", message }
 *
 * Auth: same gateway key as /v1/* — `Authorization: Bearer <key>` header
 * or `?key=<key>` query param (browsers can't set ws headers).
 * Tokens are streamed from the router's SSE executor path.
 */
import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Router } from "../router/index.js";
import type { ChatCompletionRequest, ChatMessage } from "../providers/types.js";
import type { Store } from "../store/db.js";

export interface WsDeps {
  router: Router;
  store: Store;
}

interface ChatIn {
  type: "chat";
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
}

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

export function attachWs(httpServer: HttpServer, deps: WsDeps): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = "";
    let key = "";
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      pathname = url.pathname;
      key = url.searchParams.get("key") ?? "";
    } catch {
      /* fall through to 400 */
    }
    if (pathname !== "/v1/ws") return; // not ours; leave the socket alone

    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : key.trim();
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    let record: unknown = null;
    try {
      record = deps.store.verifyApiKey(token);
    } catch {
      record = null;
    }
    if (!record) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    // serialize messages per socket so token streams never interleave
    let chain: Promise<void> = Promise.resolve();
    ws.on("message", (data) => {
      chain = chain.then(() => handleMessage(ws, deps, data)).catch(() => {});
    });
    ws.on("error", () => {});
  });

  return wss;
}

async function handleMessage(ws: WebSocket, deps: WsDeps, data: unknown): Promise<void> {
  let msg: Partial<ChatIn>;
  try {
    msg = JSON.parse(String(data)) as Partial<ChatIn>;
  } catch {
    send(ws, { type: "error", message: "invalid JSON" });
    return;
  }
  if (msg.type !== "chat" || !Array.isArray(msg.messages) || msg.messages.length === 0) {
    send(ws, { type: "error", message: 'expected {type:"chat", messages:[...], model?}' });
    return;
  }
  const stream = msg.stream !== false;
  const body: ChatCompletionRequest = {
    model: msg.model ?? "auto",
    messages: msg.messages,
    stream,
  };
  try {
    const result = await deps.router.route(body, { strategy: "priority" });
    if (result.stream) {
      for await (const chunk of result.stream) {
        const text = (chunk as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]
          ?.delta?.content;
        if (typeof text === "string" && text.length > 0) send(ws, { type: "token", text });
      }
    } else if (result.response) {
      const text = result.response.choices?.[0]?.message?.content;
      if (typeof text === "string" && text.length > 0) send(ws, { type: "token", text });
    }
    send(ws, {
      type: "done",
      provider: result.providerId,
      model: result.model,
      latencyMs: result.latencyMs,
      cached: !!result.cached,
    });
  } catch (err) {
    send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
