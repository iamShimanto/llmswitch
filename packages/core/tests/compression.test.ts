import { describe, expect, it } from "vitest";
import { cavemanCompress } from "../src/compression/caveman.js";
import { rtkCompress } from "../src/compression/rtk.js";
import { compressText } from "../src/compression/index.js";

describe("caveman", () => {
  it("strips pleasantries and hedging", () => {
    const out = cavemanCompress(
      "Hello! Could you please explain in detail how a for loop works? Thank you very much!",
    );
    expect(out.toLowerCase()).not.toContain("hello");
    expect(out.toLowerCase()).not.toContain("could you please");
    expect(out.toLowerCase()).not.toContain("thank you");
    expect(out).toContain("for loop");
  });

  it("preserves code blocks verbatim", () => {
    const code = "```js\nconst x = 1; // please keep me\n```";
    const out = cavemanCompress(`Please explain this:\n${code}`);
    expect(out).toContain("const x = 1; // please keep me");
  });

  it("preserves URLs", () => {
    const out = cavemanCompress("See https://example.com/docs for details please");
    expect(out).toContain("https://example.com/docs");
  });
});

describe("rtk", () => {
  it("dedupes repeated lines", () => {
    const out = rtkCompress("line one\nline two\nline one\nline three");
    expect(out.split("\n").filter((l) => l === "line one")).toHaveLength(1);
    expect(out).toContain("line two");
  });

  it("collapses whitespace", () => {
    expect(rtkCompress("a   b\t\tc")).toBe("a b c");
  });
});

describe("pipeline", () => {
  it("stacked reports honest stats", () => {
    const { text, stats } = compressText(
      "Hello! Could you please explain this?\n".repeat(3) + "```js\ncode();\n```",
      "stacked",
    );
    expect(stats.charsAfter).toBeLessThan(stats.charsBefore);
    expect(stats.savedPct).toBeGreaterThan(0);
    expect(stats.estTokensAfter).toBeLessThanOrEqual(stats.estTokensBefore);
    expect(text).toContain("code();");
  });
});
