import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCombo, validateCombo, type Combo } from "../src/combos/index.js";
import { Store } from "../src/store/db.js";
import type { Router } from "../src/router/index.js";

function mockRouter(): Router {
  return {
    stats: new Map(),
    route: async (body: any) => ({
      response: {
        id: "r1",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `out(${body.messages.map((m: any) => m.content).join("|")})` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      providerId: "mock",
      model: "mock-m",
      latencyMs: 10,
    }),
  } as unknown as Router;
}

describe("validateCombo", () => {
  it("accepts a valid combo", () => {
    const v = validateCombo({
      name: "draft-polish",
      description: "draft then polish",
      steps: [{ model: "auto" }, { model: "openai:gpt-4o", system: "Polish." }],
    });
    expect(v.name).toBe("draft-polish");
    expect(v.steps).toHaveLength(2);
  });

  it("rejects bad names, empty steps, too many steps", () => {
    expect(() => validateCombo({ name: "Bad!", steps: [{ model: "a" }] })).toThrow(/invalid combo name/);
    expect(() => validateCombo({ name: "ok", steps: [] })).toThrow();
    expect(() => validateCombo({ name: "ok", steps: Array(11).fill({ model: "a" }) })).toThrow();
    expect(() => validateCombo({ name: "ok", steps: [{}] })).toThrow(/model is required/);
  });
});

describe("runCombo", () => {
  it("chains outputs step to step", async () => {
    const combo: Combo = {
      name: "c",
      steps: [{ model: "m1" }, { model: "m2", system: "Refine." }],
      createdAt: 0,
    };
    const r = await runCombo(combo, "hello", mockRouter());
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].output).toContain("hello");
    // step 2 input includes step 1 output
    expect(r.steps[1].output).toContain(r.steps[0].output);
    expect(r.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(r.totalLatencyMs).toBe(20);
  });

  it("rejects empty input", async () => {
    await expect(runCombo({ name: "c", steps: [{ model: "m" }], createdAt: 0 }, "  ", mockRouter())).rejects.toThrow(
      /input is required/,
    );
  });
});

describe("Store combos", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(mkdtempSync(join(tmpdir(), "combodb-")));
  });

  it("saves, gets, lists, deletes", () => {
    expect(store.listCombos()).toEqual([]);
    store.saveCombo("c1", { description: "d1", steps: [{ model: "auto" }] });
    store.saveCombo("c2", { steps: [{ model: "m" }, { model: "n", system: "s" }] });
    expect(store.listCombos().map((c) => c.name)).toEqual(["c1", "c2"]);
    const c2 = store.getCombo("c2")!;
    expect(c2.steps).toHaveLength(2);
    expect(c2.steps[1].system).toBe("s");
    expect(store.getCombo("nope")).toBeNull();
    // upsert
    store.saveCombo("c1", { steps: [{ model: "x" }] });
    expect(store.getCombo("c1")!.steps[0].model).toBe("x");
    expect(store.deleteCombo("c1")).toBe(true);
    expect(store.deleteCombo("c1")).toBe(false);
    expect(store.listCombos().map((c) => c.name)).toEqual(["c2"]);
  });
});
