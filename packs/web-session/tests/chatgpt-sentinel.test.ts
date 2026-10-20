import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSentinelConfig,
  mintSentinelHeaders,
  requirementsPayload,
  solveProofOfWork,
} from "../src/providers/webchat/chatgptSentinel.js";

describe("sentinel proof-of-work", () => {
  it("the requirements payload carries the gAAAAAC prefix and the config", () => {
    const cfg = buildSentinelConfig("TestAgent/1.0", 1700000000000);
    const p = requirementsPayload(cfg);
    expect(p.startsWith("gAAAAAC")).toBe(true);
    const decoded = JSON.parse(Buffer.from(p.slice(7), "base64").toString("utf8"));
    expect(decoded[4]).toBe("TestAgent/1.0");
    expect(decoded[3]).toBe(0);
  });

  it("solves a challenge whose answer validates against sha3-512", () => {
    const cfg = buildSentinelConfig("TestAgent/1.0", 1700000000000);
    const seed = "test-seed-123";
    // difficulty "ff.." accepts digests whose first byte is <= 0xff — i.e.
    // only a digest starting "00".."ff"; use the loosest target instead:
    const proof = solveProofOfWork(seed, "f".repeat(64), cfg);
    expect(proof).not.toBeNull();
    const encoded = proof!.slice("gAAAAAB".length, -2);
    const digest = createHash("sha3-512").update(seed + encoded, "utf8").digest("hex");
    expect(digest.slice(0, 64) <= "f".repeat(64)).toBe(true);
    const solvedCfg = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(typeof solvedCfg[3]).toBe("number");
  });

  it("returns null for an (essentially) impossible difficulty", () => {
    const cfg = buildSentinelConfig("TestAgent/1.0", 1700000000000);
    // a target of all zeros would require a zero digest — unreachable in budget
    expect(solveProofOfWork("seed", "0".repeat(64), cfg)).toBeNull();
  }, 120_000);
});

describe("mintSentinelHeaders", () => {
  const base = {
    providerId: "chatgpt-web-free",
    userAgent: "TestAgent/1.0",
  };

  it("returns requirements + proof headers on the happy path", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          token: "req-token",
          proofofwork: { required: true, seed: "s1", difficulty: "f".repeat(64) },
          turnstile: { required: false },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const headers = await mintSentinelHeaders({ ...base, fetchFn });
    expect(headers?.["openai-sentinel-chat-requirements-token"]).toBe("req-token");
    expect(headers?.["openai-sentinel-proof-token"]).toMatch(/^gAAAAAB.*~S$/);
  });

  it("throws a clear error when Turnstile is demanded", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ token: "t", turnstile: { required: true } }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as typeof fetch;
    await expect(mintSentinelHeaders({ ...base, fetchFn })).rejects.toThrow(/Turnstile/);
  });

  it("falls back to null when the endpoint is unreachable", async () => {
    const fetchFn = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    expect(await mintSentinelHeaders({ ...base, fetchFn })).toBeNull();
  });
});
