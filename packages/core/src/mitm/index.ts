/**
 * MITM (man-in-the-middle) debugging proxy for provider integrations.
 *
 * DEBUGGING TOOL ONLY. It launches a local HTTP proxy pinned to one provider's
 * baseUrl: the client talks to localhost:<port> with NO credentials, the proxy
 * injects the provider API key server-side and forwards everything transparently,
 * logging redacted request/response pairs. Point any OpenAI-compatible client at
 * it to see exactly what goes over the wire.
 *
 * Never expose a MITM port beyond localhost. Auth headers are redacted in logs;
 * the provider key itself is never written to any log.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Inspector } from "../inspect/index.js";
import type { ResolvedProvider } from "../providers/types.js";

export interface MitmLogEntry {
  id: string;
  ts: number;
  method: string;
  path: string;
  reqHeaders: Record<string, string>;
  reqBody: string;
  reqTruncated: boolean;
  resStatus: number | null;
  resHeaders: Record<string, string>;
  resBody: string;
  resTruncated: boolean;
  latencyMs: number;
  error: string | null;
}

export interface MitmSessionInfo {
  id: string;
  providerId: string;
  /** provider baseUrl (key never included) */
  target: string;
  port: number;
  startedAt: number;
  requestCount: number;
}

/** Header names whose values are always redacted (case-insensitive). */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
]);

/** Hop-by-hop headers never forwarded upstream. */
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host", // set from target below
  "content-length", // recomputed by fetch
]);

const PREVIEW_CHARS = 8000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function redactHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.toLowerCase();
    if (SENSITIVE_HEADERS.has(name)) {
      out[name] = "[redacted]";
    } else if (v !== undefined) {
      out[name] = Array.isArray(v) ? v.join("; ") : v;
    }
  }
  return out;
}

function previewBody(buf: Buffer): { text: string; truncated: boolean } {
  // crude binary check: NUL byte in first 1k
  const head = buf.subarray(0, 1024);
  if (head.includes(0)) return { text: `[binary ${buf.length} bytes]`, truncated: false };
  const text = buf.toString("utf8");
  if (text.length <= PREVIEW_CHARS) return { text, truncated: false };
  return { text: text.slice(0, PREVIEW_CHARS), truncated: true };
}

function readBody(req: IncomingMessage): Promise<{ buf: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve({ buf: Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
  });
}

interface Session {
  info: MitmSessionInfo;
  server: Server;
  log: MitmLogEntry[];
  provider: ResolvedProvider;
}

export class MitmProxy {
  private sessions = new Map<string, Session>();

  constructor(private inspector?: Inspector) {}

  /** Start intercepting `provider` on localhost:`port` (0 = random free port). Rejects if the port is taken. */
  async start(provider: ResolvedProvider, port: number): Promise<MitmSessionInfo> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("port must be an integer 0-65535 (0 = random)");
    }
    const id = randomBytes(6).toString("hex");
    const targetBase = provider.baseUrl.replace(/\/+$/, "");
    const targetHost = new URL(provider.baseUrl).host;

    const server = createServer(async (clientReq: IncomingMessage, clientRes: ServerResponse) => {
      const entry = this.newEntry(clientReq);
      const started = Date.now();
      try {
        const { buf, tooLarge } = await readBody(clientReq);
        if (tooLarge) {
          clientRes.writeHead(413, { "content-type": "application/json" });
          clientRes.end(JSON.stringify({ error: "request body too large for MITM proxy (>8MB)" }));
          entry.error = "request body too large";
          entry.latencyMs = Date.now() - started;
          this.finishEntry(session, entry);
          return;
        }
        const reqPrev = previewBody(buf);
        entry.reqBody = reqPrev.text;
        entry.reqTruncated = reqPrev.truncated;

        // Pin the path to the provider: absolute-form URLs are reduced to their path.
        let path = clientReq.url ?? "/";
        if (/^https?:\/\//i.test(path)) {
          const u = new URL(path);
          path = u.pathname + u.search;
        }
        entry.path = path;
        const target = targetBase + path;

        const fwdHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(clientReq.headers)) {
          const name = k.toLowerCase();
          if (HOP_HEADERS.has(name) || SENSITIVE_HEADERS.has(name)) continue;
          if (v !== undefined) fwdHeaders[name] = Array.isArray(v) ? v.join("; ") : v;
        }
        fwdHeaders["host"] = targetHost;
        if (!provider.noAuth) {
          fwdHeaders["authorization"] = `Bearer ${provider.apiKey}`;
        }
        entry.reqHeaders = redactHeaders(clientReq.headers as Record<string, string | string[] | undefined>);

        const upstream = await fetch(target, {
          method: clientReq.method,
          headers: fwdHeaders,
          body:
            clientReq.method === "GET" || clientReq.method === "HEAD" || buf.length === 0
              ? undefined
              : new Uint8Array(buf),
          signal: AbortSignal.timeout(60_000),
        });

        const resBuf = Buffer.from(await upstream.arrayBuffer());
        const resPrev = previewBody(resBuf);
        entry.resStatus = upstream.status;
        entry.resHeaders = redactHeaders(
          Object.fromEntries(upstream.headers.entries()) as Record<string, string>,
        );
        entry.resBody = resPrev.text;
        entry.resTruncated = resPrev.truncated;

        const outHeaders: Record<string, string> = {};
        upstream.headers.forEach((v, k) => {
          if (!HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
        });
        clientRes.writeHead(upstream.status, outHeaders);
        clientRes.end(resBuf);
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "content-type": "application/json" });
          clientRes.end(JSON.stringify({ error: `mitm upstream error: ${entry.error}` }));
        } else {
          clientRes.end();
        }
      } finally {
        entry.latencyMs = Date.now() - started;
        this.finishEntry(session, entry);
      }
    });

    const session: Session = {
      info: {
        id,
        providerId: provider.id,
        target: targetBase,
        port,
        startedAt: Date.now(),
        requestCount: 0,
      },
      server,
      log: [],
      provider,
    };
    // `session` is referenced inside the request handler above via closure.
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    if (addr && typeof addr === "object") session.info.port = addr.port;
    this.sessions.set(id, session);
    return { ...session.info };
  }

  stop(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.server.close();
    this.sessions.delete(id);
    return true;
  }

  list(): MitmSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }));
  }

  getLog(id: string): MitmLogEntry[] | undefined {
    const s = this.sessions.get(id);
    return s ? [...s.log].reverse() : undefined;
  }

  private newEntry(clientReq: IncomingMessage): MitmLogEntry {
    return {
      id: randomBytes(6).toString("hex"),
      ts: Date.now(),
      method: clientReq.method ?? "?",
      path: clientReq.url ?? "/",
      reqHeaders: {},
      reqBody: "",
      reqTruncated: false,
      resStatus: null,
      resHeaders: {},
      resBody: "",
      resTruncated: false,
      latencyMs: 0,
      error: null,
    };
  }

  private finishEntry(session: Session, entry: MitmLogEntry): void {
    session.info.requestCount += 1;
    session.log.unshift(entry);
    if (session.log.length > 100) session.log.length = 100;
    // Mirror into the inspector ring buffer so MITM traffic shows in the dashboard.
    this.inspector?.record({
      keyId: null,
      provider: session.provider.id,
      model: "mitm",
      strategy: "mitm",
      status: entry.resStatus !== null && entry.resStatus < 400 && !entry.error ? "ok" : "error",
      latencyMs: entry.latencyMs,
      cached: false,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      request: [{ role: "system", content: `MITM ${entry.method} ${entry.path}`.slice(0, 500) }],
      responsePreview: entry.error ?? entry.resBody.slice(0, 500),
    });
  }
}
