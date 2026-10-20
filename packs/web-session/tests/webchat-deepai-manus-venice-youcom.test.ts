import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { WebChatError } from "../src/providers/webchat/types.js";
import { DeepAiDriver } from "../src/providers/webchat/deepai.js";
import { ManusDriver } from "../src/providers/webchat/manus.js";
import {
  VENICE_CLERK_URL,
  VENICE_INFERENCE_URL,
  VeniceWebDriver,
  buildVeniceBody,
  decodeJwtPayload,
  extractClientJwt,
  parseVeniceLine,
} from "../src/providers/webchat/venice-web.js";
import { YouComWebDriver } from "../src/providers/webchat/you-com-web.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** A fake (unsigned) session JWT whose payload the driver can decode. */
function fakeSessionJwt(sub = "user_123"): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ sub, exp: 9_999_999_999 })}.fakesig`;
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

/** A fetch that must never be called (gap-stub drivers send nothing). */
function forbiddenFetch(counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls++;
    throw new Error("network must not be touched by a gap-stub driver");
  }) as typeof fetch;
}

// ─── DeepAI (gap stub) ──────────────────────────────────────────────────────

describe("deepai driver (OmniRoute gap stub)", () => {
  it("exposes the registry id and documents the missing cookie flow", () => {
    const d = new DeepAiDriver(new CookieJar());
    expect(d.id).toBe("deepai");
    expect(d.cookieDomains).toEqual(["deepai.org"]);
    expect(d.cookieHint).toMatch(/API-key image provider/);
  });

  it("bootstrap rejects without cookies, with the import hint", async () => {
    const d = new DeepAiDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(WebChatError);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies deepai/);
  });

  it("chat rejects with the import hint when cookies are missing", async () => {
    const d = new DeepAiDriver(new CookieJar());
    await expect(d.chat("text2img", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /llmswitch cookies deepai/,
    );
  });

  it("bootstrap validates cookies (idempotent) and never fetches", async () => {
    const counter = { calls: 0 };
    const jar = new CookieJar();
    jar.load("session=abc", "deepai.org");
    const d = new DeepAiDriver(jar, forbiddenFetch(counter));
    await expect(d.bootstrap()).resolves.toBeUndefined();
    await expect(d.bootstrap()).resolves.toBeUndefined();
    expect(counter.calls).toBe(0);
  });

  it("chat throws the documented gap error once cookies exist", async () => {
    const jar = new CookieJar();
    jar.load("session=abc", "deepai.org");
    const d = new DeepAiDriver(jar);
    const err = await d.chat("text2img", [{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(WebChatError);
    expect(err.providerId).toBe("deepai");
    expect(err.message).toMatch(/no web chat protocol exists in OmniRoute/);
    expect(err.message).toMatch(/text2img/);
    expect(err.message).toMatch(/NEEDS LIVE VERIFICATION/);
  });

  it("chatStream throws the same gap error", async () => {
    const jar = new CookieJar();
    jar.load("session=abc", "deepai.org");
    const d = new DeepAiDriver(jar);
    await expect(collect(d.chatStream("m", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      /no web chat protocol exists in OmniRoute/,
    );
  });
});

// ─── Manus (gap stub) ───────────────────────────────────────────────────────

describe("manus driver (OmniRoute gap stub)", () => {
  it("uses the tokenExtractionConfig id and cookie", () => {
    const d = new ManusDriver(new CookieJar());
    expect(d.id).toBe("manus");
    expect(d.cookieDomains).toEqual(["manus.im"]);
    expect(d.cookieHint).toMatch(/manus_session/);
    expect(d.cookieHint).toMatch(/manus\.im\/login/);
  });

  it("bootstrap rejects without cookies, with the import hint", async () => {
    const d = new ManusDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(WebChatError);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies manus/);
  });

  it("bootstrap rejects manus.im cookies that lack manus_session", async () => {
    const jar = new CookieJar();
    jar.load("some_other_cookie=1", "manus.im");
    const d = new ManusDriver(jar);
    await expect(d.bootstrap()).rejects.toThrow(/manus_session/);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies manus/);
  });

  it("bootstrap validates manus_session (idempotent) and never fetches", async () => {
    const counter = { calls: 0 };
    const jar = new CookieJar();
    jar.load("manus_session=sess-123; other=1", "manus.im");
    const d = new ManusDriver(jar, forbiddenFetch(counter));
    await expect(d.bootstrap()).resolves.toBeUndefined();
    await expect(d.bootstrap()).resolves.toBeUndefined();
    expect(counter.calls).toBe(0);
  });

  it("chat throws the documented gap error once the cookie exists", async () => {
    const jar = new CookieJar();
    jar.load("manus_session=sess-123", "manus.im");
    const d = new ManusDriver(jar);
    const err = await d.chat("m", [{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(WebChatError);
    expect(err.providerId).toBe("manus");
    expect(err.message).toMatch(/protocol not present in OmniRoute code/);
    expect(err.message).toMatch(/NEEDS LIVE VERIFICATION/);
  });

  it("chatStream throws the same gap error", async () => {
    const jar = new CookieJar();
    jar.load("manus_session=sess-123", "manus.im");
    const d = new ManusDriver(jar);
    await expect(collect(d.chatStream("m", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      /protocol not present in OmniRoute code/,
    );
  });
});

// ─── You.com (gap stub) ─────────────────────────────────────────────────────

describe("you-com-web driver (OmniRoute gap stub)", () => {
  it("exposes the task id and the search-only reality in its hint", () => {
    const d = new YouComWebDriver(new CookieJar());
    expect(d.id).toBe("you-com-web");
    expect(d.cookieDomains).toEqual(["you.com"]);
    expect(d.cookieHint).toMatch(/API-key search/);
  });

  it("bootstrap rejects without cookies, with the import hint", async () => {
    const d = new YouComWebDriver(new CookieJar());
    await expect(d.bootstrap()).rejects.toThrow(WebChatError);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies you-com-web/);
  });

  it("chat rejects with the import hint when cookies are missing", async () => {
    const d = new YouComWebDriver(new CookieJar());
    await expect(d.chat("m", [{ role: "user", content: "hi" }])).rejects.toThrow(
      /llmswitch cookies you-com-web/,
    );
  });

  it("bootstrap validates cookies (idempotent) and never fetches", async () => {
    const counter = { calls: 0 };
    const jar = new CookieJar();
    jar.load("session=abc", "you.com");
    const d = new YouComWebDriver(jar, forbiddenFetch(counter));
    await expect(d.bootstrap()).resolves.toBeUndefined();
    await expect(d.bootstrap()).resolves.toBeUndefined();
    expect(counter.calls).toBe(0);
  });

  it("chat throws the documented gap error once cookies exist", async () => {
    const jar = new CookieJar();
    jar.load("session=abc", "you.com");
    const d = new YouComWebDriver(jar);
    const err = await d.chat("m", [{ role: "user", content: "hi" }]).catch((e) => e);
    expect(err).toBeInstanceOf(WebChatError);
    expect(err.providerId).toBe("you-com-web");
    // The gap: OmniRoute's only You.com code is the API-key search provider.
    expect(err.message).toMatch(/youcom-search/);
    expect(err.message).toMatch(/ydc-index\.io/);
    expect(err.message).toMatch(/NEEDS LIVE VERIFICATION/);
  });

  it("chatStream throws the same gap error", async () => {
    const jar = new CookieJar();
    jar.load("session=abc", "you.com");
    const d = new YouComWebDriver(jar);
    await expect(collect(d.chatStream("m", [{ role: "user", content: "hi" }]))).rejects.toThrow(
      /not present in OmniRoute code/,
    );
  });
});

// ─── Venice helpers (ported from venice-web-auth / venice-web) ──────────────

describe("venice helpers", () => {
  it("extractClientJwt handles bare values, pairs and full headers", () => {
    expect(extractClientJwt("client-jwt")).toBe("client-jwt");
    expect(extractClientJwt("__client=client-jwt")).toBe("client-jwt");
    expect(extractClientJwt("a=1; __client=client-jwt; b=2")).toBe("client-jwt");
    expect(extractClientJwt("cookie: __client=client-jwt")).toBe("client-jwt");
  });

  it("decodeJwtPayload reads claims and tolerates garbage", () => {
    const jwt = fakeSessionJwt("user_9");
    expect(decodeJwtPayload(jwt).sub).toBe("user_9");
    expect(decodeJwtPayload("not-a-jwt")).toEqual({});
    expect(decodeJwtPayload("")).toEqual({});
  });

  it("parseVeniceLine parses NDJSON events and skips junk", () => {
    expect(parseVeniceLine('{"kind":"content","content":"x"}')?.content).toBe("x");
    expect(parseVeniceLine("")).toBeNull();
    expect(parseVeniceLine("not json")).toBeNull();
    expect(parseVeniceLine("42")).toBeNull();
  });

  it("buildVeniceBody matches the executor's payload shape", () => {
    const body = buildVeniceBody("venice-default", [{ role: "user", content: "hi" }], "user_1");
    expect(body.modelId).toBe("venice-default");
    expect(body.prompt).toEqual([{ role: "user", content: "hi" }]);
    expect(body.userId).toBe("user_1");
    expect(body.temperature).toBe(0.7);
    expect(body.topP).toBe(0.9);
    expect(body.reasoning).toBe(false);
    expect(body.conversationType).toBe("text");
    expect(body.webEnabled).toBe(false);
    expect(body.includeVeniceSystemPrompt).toBe(false);
    expect(String(body.requestId)).toHaveLength(7);
  });
});

// ─── Venice driver (real protocol, mock fetch) ──────────────────────────────

interface SeenCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const NDJSON_REPLY = [
  JSON.stringify({ kind: "meta", content: "" }),
  JSON.stringify({ kind: "content", content: "Hello " }),
  JSON.stringify({ kind: "content", reasoning_content: "thinking…" }),
  "this line is not json",
  JSON.stringify({ kind: "content", content: "world" }),
  "",
].join("\n");

function veniceFetch(opts: {
  sessions?: Array<Record<string, string>>;
  clerkStatus?: number;
  inferenceFailures?: number[];
  seen: SeenCall[];
}): typeof fetch {
  let inferenceAttempts = 0;
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    opts.seen.push({
      url: u,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (u === `${VENICE_CLERK_URL}/v1/client`) {
      if (opts.clerkStatus && opts.clerkStatus !== 200) {
        return new Response("denied", { status: opts.clerkStatus });
      }
      return json({ response: { sessions: opts.sessions ?? [{ id: "sess_1", status: "active" }] } });
    }
    if (u === `${VENICE_CLERK_URL}/v1/client/sessions/sess_1/tokens`) {
      return json({ jwt: fakeSessionJwt() });
    }
    if (u === VENICE_INFERENCE_URL) {
      inferenceAttempts++;
      const failStatus = opts.inferenceFailures?.[inferenceAttempts - 1];
      if (failStatus) return new Response("upstream said no", { status: failStatus });
      return new Response(NDJSON_REPLY, { headers: { "content-type": "text/html" } });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function veniceJar(): CookieJar {
  const jar = new CookieJar();
  jar.load("__client=client-jwt-value", "clerk.venice.ai");
  return jar;
}

describe("venice-web driver (mock fetch)", () => {
  it("exposes OmniRoute's executor id and both cookie domains", () => {
    const d = new VeniceWebDriver(new CookieJar());
    expect(d.id).toBe("venice-web");
    expect(d.cookieDomains).toEqual(["venice.ai", "clerk.venice.ai"]);
    expect(d.cookieHint).toMatch(/__client/);
  });

  it("bootstrap rejects without cookies, with the import hint", async () => {
    const d = new VeniceWebDriver(new CookieJar(), veniceFetch({ seen: [] }));
    await expect(d.bootstrap()).rejects.toThrow(WebChatError);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies venice-web/);
  });

  it("bootstrap rejects a jar holding only venice_session (executor needs __client)", async () => {
    const jar = new CookieJar();
    jar.load("venice_session=sess", "venice.ai");
    const d = new VeniceWebDriver(jar, veniceFetch({ seen: [] }));
    await expect(d.bootstrap()).rejects.toThrow(/__client/);
    await expect(d.bootstrap()).rejects.toThrow(/llmswitch cookies venice-web/);
  });

  it("bootstrap runs the Clerk GET-client → POST-tokens exchange, then caches", async () => {
    const seen: SeenCall[] = [];
    const d = new VeniceWebDriver(veniceJar(), veniceFetch({ seen }));
    await d.bootstrap();
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url).toBe(`${VENICE_CLERK_URL}/v1/client`);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.headers.cookie).toBe("__client=client-jwt-value");
    expect(seen[0]!.headers.origin).toBe("https://venice.ai");
    expect(seen[1]!.url).toBe(`${VENICE_CLERK_URL}/v1/client/sessions/sess_1/tokens`);
    expect(seen[1]!.method).toBe("POST");
    // Idempotent: the cached JWT (exp far in the future) is reused.
    await d.bootstrap();
    expect(seen).toHaveLength(2);
  });

  it("bootstrap also finds __client imported under the parent venice.ai domain", async () => {
    const seen: SeenCall[] = [];
    const jar = new CookieJar();
    jar.load("__client=parent-jwt", "venice.ai");
    const d = new VeniceWebDriver(jar, veniceFetch({ seen }));
    await expect(d.bootstrap()).resolves.toBeUndefined();
    expect(seen[0]!.headers.cookie).toBe("__client=parent-jwt");
  });

  it("bootstrap fails when Clerk reports no active session", async () => {
    const d = new VeniceWebDriver(
      veniceJar(),
      veniceFetch({ seen: [], sessions: [{ id: "s0", status: "ended" }] }),
    );
    await expect(d.bootstrap()).rejects.toThrow(/no active Clerk session/);
  });

  it("bootstrap surfaces Clerk HTTP errors", async () => {
    const d = new VeniceWebDriver(veniceJar(), veniceFetch({ seen: [], clerkStatus: 401 }));
    await expect(d.bootstrap()).rejects.toThrow(/Clerk \/v1\/client returned HTTP 401/);
  });

  it("chat posts the executor payload and collects NDJSON content", async () => {
    const seen: SeenCall[] = [];
    const d = new VeniceWebDriver(veniceJar(), veniceFetch({ seen }));
    const reply = await d.chat("venice-default", [{ role: "user", content: "hi" }]);
    expect(reply).toBe("Hello world");

    const call = seen.find((c) => c.url === VENICE_INFERENCE_URL)!;
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${fakeSessionJwt()}`);
    expect(call.headers["x-venice-version"]).toBe("interface@web");
    expect(call.headers["x-venice-middleface-version"]).toBe("outerface@web");
    expect(call.headers.referer).toBe("https://venice.ai/");
    const body = JSON.parse(call.body!) as Record<string, unknown>;
    expect(body.modelId).toBe("venice-default");
    expect(body.prompt).toEqual([{ role: "user", content: "hi" }]);
    expect(body.userId).toBe("user_123"); // sub claim of the minted JWT
    expect(body.conversationType).toBe("text");
  });

  it("chatStream yields only the content deltas, in order", async () => {
    const d = new VeniceWebDriver(veniceJar(), veniceFetch({ seen: [] }));
    const deltas = await collect(d.chatStream("m", [{ role: "user", content: "hi" }]));
    expect(deltas).toEqual(["Hello ", "world"]);
  });

  it("a 401 from inference evicts the JWT, so the next chat re-bootstraps", async () => {
    const seen: SeenCall[] = [];
    const d = new VeniceWebDriver(veniceJar(), veniceFetch({ seen, inferenceFailures: [401] }));
    await expect(d.chat("m", [{ role: "user", content: "hi" }])).rejects.toThrow(/HTTP 401/);
    const reply = await d.chat("m", [{ role: "user", content: "hi" }]);
    expect(reply).toBe("Hello world");
    const clerkGets = seen.filter((c) => c.url === `${VENICE_CLERK_URL}/v1/client`);
    expect(clerkGets).toHaveLength(2);
  });
});
