import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry, parseSkillMarkdown } from "../src/skills/index.js";
import type { Router } from "../src/router/index.js";

function mockRouter(reply = "mocked"): Router {
  return {
    stats: new Map(),
    route: async (body: any) => ({
      response: {
        id: "r1",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      providerId: "mock",
      model: body.model === "auto" ? "mock-m" : body.model,
      latencyMs: 42,
    }),
  } as unknown as Router;
}

describe("parseSkillMarkdown", () => {
  it("parses frontmatter + body", () => {
    const s = parseSkillMarkdown(
      "---\nname: myskill\ndescription: does things\nmodel: groq:llama\n---\nBe helpful.",
      "fallback",
    );
    expect(s.name).toBe("myskill");
    expect(s.description).toBe("does things");
    expect(s.model).toBe("groq:llama");
    expect(s.instructions).toBe("Be helpful.");
  });

  it("works without frontmatter", () => {
    const s = parseSkillMarkdown("Just do it.", "fallback");
    expect(s.name).toBe("fallback");
    expect(s.instructions).toBe("Just do it.");
  });
});

describe("SkillRegistry", () => {
  let dir: string;
  let reg: SkillRegistry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skills-"));
    reg = new SkillRegistry(dir);
  });

  it("ships builtins", () => {
    const names = reg.list().map((s) => s.name);
    expect(names).toContain("summarize");
    expect(names).toContain("translate-bn");
    expect(names).toContain("code-review");
  });

  it("loads .md files from dir", () => {
    writeFileSync(join(dir, "custom.md"), "---\ndescription: custom one\n---\nDo custom stuff.");
    const r2 = new SkillRegistry(dir);
    const s = r2.get("custom");
    expect(s?.description).toBe("custom one");
    expect(s?.instructions).toBe("Do custom stuff.");
  });

  it("saves and deletes via API (persisted as file)", () => {
    const s = reg.save({ name: "my-skill", description: "d", instructions: "Do X." });
    expect(s.source).toBe("file");
    expect(reg.get("my-skill")?.instructions).toBe("Do X.");
    // survives re-load
    expect(new SkillRegistry(dir).get("my-skill")?.instructions).toBe("Do X.");
    expect(reg.delete("my-skill")).toBe(true);
    expect(reg.get("my-skill")).toBeUndefined();
  });

  it("rejects bad names and builtin overwrite", () => {
    expect(() => reg.save({ name: "Bad Name!", instructions: "x" })).toThrow(/invalid skill name/);
    expect(() => reg.save({ name: "summarize", instructions: "x" })).toThrow(/built-in/);
    expect(reg.delete("summarize")).toBe(false);
  });

  it("runs a skill through the router with system prompt", async () => {
    let seen: any = null;
    const router: Router = {
      stats: new Map(),
      route: async (body: any) => {
        seen = body;
        return {
          response: {
            id: "r1",
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
          providerId: "mock",
          model: "m",
          latencyMs: 42,
        };
      },
    } as unknown as Router;
    const skill = reg.get("summarize")!;
    const r = await reg.run(skill, "hello world", router);
    expect(r.output).toBe("done");
    expect(seen.messages[0].role).toBe("system");
    expect(seen.messages[0].content).toContain("summarizer");
    expect(seen.messages[1]).toEqual({ role: "user", content: "hello world" });
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });

  it("model override wins over skill default", async () => {
    let seen: any = null;
    const router = mockRouter();
    const orig = router.route;
    (router as any).route = async (body: any) => {
      seen = body;
      return orig(body);
    };
    await reg.run(reg.get("summarize")!, "hi", router, "openai:gpt-4o");
    expect(seen.model).toBe("openai:gpt-4o");
  });
});
