import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryStore } from "../src/store/db.js";
import { AccountPool } from "../src/accounts/index.js";
import { orderAccounts } from "../src/accounts/selection.js";
import { createRouter, matchRoutingRule } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";
import type { RoutingRule } from "../src/store/db.js";

function prov(id: string, extra: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id,
    name: id,
    baseUrl: "https://example.com",
    wireFormat: "openai",
    models: ["m"],
    defaultModel: "m",
    costTier: 3,
    apiKey: "k1",
    allKeys: ["k1"],
    ...extra,
  } as ResolvedProvider;
}

function jsonResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const body = { model: "m", messages: [{ role: "user" as const, content: "hi" }] };

describe("store: provider accounts + routing rules", () => {
  it("accounts CRUD + use recording", () => {
    const s = memoryStore();
    const a = s.addAccount({ providerId: "groq", label: "main", kind: "api_key", secret: "sk-1" });
    const b = s.addAccount({ providerId: "groq", label: "backup", kind: "api_key", secret: "sk-2" });
    expect(s.listAccounts("groq").map((x) => x.label)).toEqual(["main", "backup"]);
    s.recordAccountUse(a.id, true);
    s.recordAccountUse(a.id, false, "HTTP 401");
    const after = s.getAccount(a.id)!;
    expect(after.calls).toBe(2);
    expect(after.errors).toBe(1);
    expect(after.lastError).toBe("HTTP 401");
    expect(after.lastUsedAt).not.toBeNull();
    expect(s.updateAccount(b.id, { enabled: false })).toBe(true);
    expect(s.getAccount(b.id)!.enabled).toBe(false);
    expect(s.deleteAccount(b.id)).toBe(true);
    expect(s.listAccounts("groq")).toHaveLength(1);
    s.close();
  });

  it("routing rules CRUD", () => {
    const s = memoryStore();
    const r = s.addRoutingRule({ pattern: "gpt-*", providers: ["openai", "groq"], strategy: "cost-optimized" });
    expect(r.providers).toEqual(["openai", "groq"]);
    expect(s.listRoutingRules()).toHaveLength(1);
    expect(s.updateRoutingRule(r.id, { enabled: false })).toBe(true);
    expect(s.listRoutingRules()[0]!.enabled).toBe(false);
    expect(s.deleteRoutingRule(r.id)).toBe(true);
    expect(s.listRoutingRules()).toHaveLength(0);
    s.close();
  });
});

describe("account selection strategies", () => {
  it("pool: priority keeps configured order, least-used rotates by usage", () => {
    const pool = new AccountPool(["a", "b", "c"]);
    expect(pool.next(new Set(), Date.now(), "priority")).toBe("a");
    pool.reportSuccess("a");
    pool.reportSuccess("a");
    pool.reportSuccess("b");
    // least-used: c (0 uses) first
    expect(pool.next(new Set(), Date.now(), "least-used")).toBe("c");
  });

  it("orderAccounts: least-used sorts by calls; priority keeps order", () => {
    const accts = [
      { id: "x", calls: 5 },
      { id: "y", calls: 1 },
      { id: "z", calls: 3 },
    ];
    expect(orderAccounts("p", accts, "least-used").map((a) => a.id)).toEqual(["y", "z", "x"]);
    expect(orderAccounts("p", accts, "priority").map((a) => a.id)).toEqual(["x", "y", "z"]);
    const rr = orderAccounts("p-rr", accts, "round-robin").map((a) => a.id);
    const rr2 = orderAccounts("p-rr", accts, "round-robin").map((a) => a.id);
    expect(rr[0]).not.toBe(rr2[0]); // cursor advances between calls
  });
});

describe("router: api-key account rotation + attribution", () => {
  it("bad key cools, next account serves, result carries accountId", async () => {
    const recorded: Array<[string, boolean]> = [];
    const p = prov("groq", {
      apiKey: "bad-key",
      allKeys: ["bad-key", "good-key"],
      keyAccounts: new Map([
        ["bad-key", "acct_bad"],
        ["good-key", "acct_good"],
      ]),
    });
    const fetchFn = (async (_url: string, init: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? "";
      return auth.includes("good-key") ? jsonResponse("ok") : jsonResponse("no", 401);
    }) as unknown as typeof fetch;
    const router = createRouter([p], {
      accounts: {
        strategy: () => "priority",
        stats: () => [],
        record: (id, ok) => recorded.push([id, ok]),
      },
    });
    const res = await router.route(body, { fetchFn });
    expect(res.providerId).toBe("groq");
    expect(res.accountId).toBe("acct_good");
    expect(recorded).toContainEqual(["acct_bad", false]);
    expect(recorded).toContainEqual(["acct_good", true]);
  });
});

describe("router: session account rotation", () => {
  it("missing account session falls through to the next account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmswitch-acct-"));
    process.env.LLMSWITCH_SESSIONS_DIR = dir;
    try {
      // account B has a valid stored session; account A has none.
      writeFileSync(
        join(dir, "cursor--acct_b.json"),
        JSON.stringify({ accessToken: "tok-b", expiresAt: Date.now() + 3600_000 }),
      );
      const recorded: Array<[string, boolean]> = [];
      const p = prov("cursor", {
        accounts: [
          { id: "acct_a", label: "A", kind: "session" },
          { id: "acct_b", label: "B", kind: "session" },
        ],
      });
      const router = createRouter([p], {
        accounts: {
          strategy: () => "priority",
          stats: () => [],
          record: (id, ok) => recorded.push([id, ok]),
        },
      });
      // Cursor's wire transport is unported: with creds resolved the
      // executor throws its wire error — which proves account B was
      // reached (account A failed earlier with an auth error).
      await expect(router.route(body, { fetchFn: fetch })).rejects.toThrow(/wire|protobuf|not ported/i);
      expect(recorded).toContainEqual(["acct_a", false]);
    } finally {
      delete process.env.LLMSWITCH_SESSIONS_DIR;
    }
  });

  it("a real account's 429 is not masked by the default candidate's missing session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llmswitch-acct-"));
    process.env.LLMSWITCH_SESSIONS_DIR = dir;
    try {
      // The one DB account has a session; the default (no-account)
      // candidate has none. The account's upstream verdict is a 429
      // quota exhaustion — that, not "no session", must surface.
      writeFileSync(
        join(dir, "antigravity--acct_a.json"),
        JSON.stringify({
          accessToken: "tok-a",
          expiresAt: Date.now() + 3600_000,
          projectId: "p1",
          email: "a@example.com",
        }),
      );
      const p = prov("antigravity", {
        accounts: [{ id: "acct_a", label: "A", kind: "session" }],
      });
      const router = createRouter([p], {
        accounts: {
          strategy: () => "priority",
          stats: () => [],
          record: () => {},
        },
      });
      const fetchFn = (async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "You have exhausted your capacity on this model. Your quota will reset after 4h0m0s.",
              status: "RESOURCE_EXHAUSTED",
            },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch;
      await expect(router.route(body, { fetchFn })).rejects.toThrow(/exhausted your capacity/);
    } finally {
      delete process.env.LLMSWITCH_SESSIONS_DIR;
    }
  });
});

describe("routing rules", () => {
  const rule = (patch: Partial<RoutingRule>): RoutingRule => ({
    id: "r1",
    pattern: "m",
    providers: ["b"],
    strategy: "",
    enabled: true,
    createdAt: 0,
    ...patch,
  });

  it("matchRoutingRule: exact, prefix, pinned skip, disabled skip", () => {
    expect(matchRoutingRule([rule({})], "m")?.id).toBe("r1");
    expect(matchRoutingRule([rule({ pattern: "gpt-*" })], "gpt-5")).not.toBeNull();
    expect(matchRoutingRule([rule({})], "a:m")).toBeNull(); // pinned bypasses rules
    expect(matchRoutingRule([rule({ enabled: false })], "m")).toBeNull();
    expect(matchRoutingRule([rule({})], "auto")).toBeNull();
    expect(matchRoutingRule([rule({})], "other")).toBeNull();
  });

  it("a rule restricts the chain to its providers", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return url.includes("a.example") ? jsonResponse("boom", 500) : jsonResponse("ok");
    }) as unknown as typeof fetch;
    const a = prov("a", { baseUrl: "https://a.example" });
    const b = prov("b", { baseUrl: "https://b.example" });
    const router = createRouter([a, b], { routingRules: () => [rule({})] });
    const res = await router.route(body, { fetchFn });
    expect(res.providerId).toBe("b");
    expect(calls.every((u) => u.includes("b.example"))).toBe(true);
  });

  it("pinned models ignore rules", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      return url.includes("a.example") ? jsonResponse("from-a") : jsonResponse("from-b");
    }) as unknown as typeof fetch;
    const a = prov("a", { baseUrl: "https://a.example" });
    const b = prov("b", { baseUrl: "https://b.example" });
    const router = createRouter([a, b], { routingRules: () => [rule({})] });
    const res = await router.route({ ...body, model: "a:m" }, { fetchFn });
    expect(res.providerId).toBe("a");
    expect(calls.some((u) => u.includes("a.example"))).toBe(true);
  });
});
