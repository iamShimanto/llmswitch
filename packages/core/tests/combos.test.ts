import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCombo,
  validateCombo,
  validateAnyCombo,
  orderComboTargets,
  type Combo,
} from "../src/combos/index.js";
import { createRouter } from "../src/router/index.js";
import type { ResolvedProvider } from "../src/providers/types.js";
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


describe("validateAnyCombo (router combos)", () => {
  it("accepts targets and defaults strategy to priority", () => {
    const v = validateAnyCombo({
      name: "free-pool",
      targets: [{ model: "kilo-gateway:llama" }, { model: "ovhcloud:llama" }],
    });
    expect(v.kind).toBe("router");
    if (v.kind === "router") {
      expect(v.strategy).toBe("priority");
      expect(v.targets).toHaveLength(2);
    }
  });

  it("keeps weights and rejects self-targets", () => {
    const v = validateAnyCombo({
      name: "mix",
      strategy: "weighted",
      targets: [{ model: "a:m", weight: 3 }, { model: "b:m" }],
    });
    if (v.kind === "router") expect(v.targets[0]!.weight).toBe(3);
    expect(() =>
      validateAnyCombo({ name: "mix", targets: [{ model: "mix" }] }),
    ).toThrow(/itself/);
  });
});

describe("orderComboTargets", () => {
  const ctx = {
    providerCalls: (pid: string) => (pid === "busy" ? 50 : 2),
    providerOf: (m: string) => m.split(":")[0]!,
    providerTier: (m: string) => (m.startsWith("cheap") ? 1 : 5),
    cursor: 0,
  };
  const targets = [{ model: "busy:x" }, { model: "cheap:y" }, { model: "calm:z" }];

  it("priority keeps the listed order", () => {
    expect(orderComboTargets("priority", targets, ctx).map((t) => t.model)).toEqual([
      "busy:x",
      "cheap:y",
      "calm:z",
    ]);
  });

  it("round-robin rotates by cursor", () => {
    expect(
      orderComboTargets("round-robin", targets, { ...ctx, cursor: 1 }).map((t) => t.model),
    ).toEqual(["cheap:y", "calm:z", "busy:x"]);
  });

  it("least-used puts the busiest provider last", () => {
    const out = orderComboTargets("least-used", targets, ctx).map((t) => t.model);
    expect(out[out.length - 1]).toBe("busy:x");
  });

  it("cost-optimized puts the cheapest tier first", () => {
    expect(orderComboTargets("cost-optimized", targets, ctx)[0]!.model).toBe("cheap:y");
  });

  it("weighted honors the random pick", () => {
    const w = [{ model: "a:m", weight: 1 }, { model: "b:m", weight: 9 }];
    expect(orderComboTargets("weighted", w, { ...ctx, random: () => 0.95 })[0]!.model).toBe("b:m");
    expect(orderComboTargets("weighted", w, { ...ctx, random: () => 0.01 })[0]!.model).toBe("a:m");
  });
});

describe("router combo execution", () => {
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

  function rprov(id: string, model: string): ResolvedProvider {
    return {
      id,
      name: id,
      baseUrl: `https://${id}.example/v1`,
      wireFormat: "openai",
      models: [model],
      defaultModel: model,
      costTier: 3,
      apiKey: "k",
      allKeys: ["k"],
    } as ResolvedProvider;
  }
  const chatBody = { model: "free-pool", messages: [{ role: "user" as const, content: "hi" }] };

  it("falls through a failing target to the next", async () => {
    const fetchFn = (async (url: string) =>
      String(url).includes("prov-a")
        ? new Response("bad key", { status: 401 })
        : jsonResponse("from-b")) as typeof fetch;
    const router = createRouter([rprov("prov-a", "ma"), rprov("prov-b", "mb")], {
      combos: () => [
        {
          name: "free-pool",
          kind: "router",
          strategy: "priority",
          targets: [{ model: "prov-a:ma" }, { model: "prov-b:mb" }],
          createdAt: 1,
        },
      ],
    });
    const r = await router.route(chatBody, { fetchFn });
    expect(r.providerId).toBe("prov-b");
    expect(r.response?.choices[0]?.message.content).toBe("from-b");
  });

  it("throws an aggregated error when every target fails", async () => {
    const fetchFn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const router = createRouter([rprov("prov-a", "ma")], {
      combos: () => [
        {
          name: "free-pool",
          kind: "router",
          strategy: "priority",
          targets: [{ model: "prov-a:ma" }],
          createdAt: 1,
        },
      ],
    });
    await expect(router.route(chatBody, { fetchFn })).rejects.toThrow(/combo "free-pool"/);
  });

  it("resolves nested combos", async () => {
    const fetchFn = (async () => jsonResponse("deep")) as unknown as typeof fetch;
    const router = createRouter([rprov("prov-b", "mb")], {
      combos: () => [
        { name: "inner", kind: "router", strategy: "priority", targets: [{ model: "prov-b:mb" }], createdAt: 1 },
        { name: "free-pool", kind: "router", strategy: "priority", targets: [{ model: "inner" }], createdAt: 1 },
      ],
    });
    const r = await router.route(chatBody, { fetchFn });
    expect(r.response?.choices[0]?.message.content).toBe("deep");
  });
});
