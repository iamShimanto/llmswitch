import { describe, expect, it } from "vitest";
import { redactEnabled, redactPii } from "../src/privacy/redact.js";
import { memoryStore } from "../src/store/db.js";

describe("redactPii", () => {
  it("redacts emails", () => {
    const r = redactPii("contact me at arif@example.com please");
    expect(r.text).toContain("[EMAIL]");
    expect(r.text).not.toContain("arif@example.com");
    expect(r.kinds).toContain("email");
  });

  it("redacts API keys", () => {
    const r = redactPii("key is sk-abcDEF1234567890 done");
    expect(r.text).toContain("[API_KEY]");
    expect(r.text).not.toContain("sk-abcDEF1234567890");
  });

  it("redacts card numbers", () => {
    const r = redactPii("card 4111 1111 1111 1111 ok");
    expect(r.text).toContain("[CARD]");
  });

  it("leaves clean text untouched", () => {
    const r = redactPii("The weather in Dhaka is nice today.");
    expect(r.redactions).toBe(0);
    expect(r.text).toBe("The weather in Dhaka is nice today.");
  });

  it("redactEnabled defaults on, PII_REDACT=0 disables", () => {
    expect(redactEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(redactEnabled({ PII_REDACT: "0" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("audit log", () => {
  it("records and lists events", () => {
    const s = memoryStore();
    s.audit("key.created", "k1", "name=test");
    s.audit("cache.cleared");
    const rows = s.listAudit(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe("cache.cleared"); // newest first
    expect(rows[1]!.keyId).toBe("k1");
    expect(rows[1]!.detail).toBe("name=test");
    s.close();
  });

  it("never throws on bad input", () => {
    const s = memoryStore();
    expect(() => s.audit("x".repeat(5000), null, "y".repeat(5000))).not.toThrow();
    s.close();
  });
});
