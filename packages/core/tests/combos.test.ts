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
import { autoTemplate, buildAutoTargets, classifyModel } from "../src/combos/autoCatalog.js";
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


describe("validateAnyCombo v2 (accounts/config/slash names)", () => {
  it("accepts slash names and account pins, rejects auto/ and colons", () => {
    const v = validateAnyCombo({
      name: "shimanto/main",
      targets: [{ model: "antigravity/claude-sonnet-4-6", accountId: "acct_1" }],
    });
    expect(v.kind).toBe("router");
    if (v.kind === "router") expect(v.targets[0]!.accountId).toBe("acct_1");
    expect(() => validateAnyCombo({ name: "auto/x", targets: [{ model: "a:b" }] })).toThrow();
    expect(() => validateAnyCombo({ name: "a:b", targets: [{ model: "a:b" }] })).toThrow();
  });

  it("sanitizes config (system prompt, validation, context length)", () => {
    const v = validateAnyCombo({
      name: "guarded",
      targets: [{ model: "a:b" }],
      config: {
        systemPrompt: "Be terse.",
        contextLength: 128000,
        validation: { forbidden: ["I cannot help"], minLength: 3 },
      },
    });
    if (v.kind === "router") {
      expect(v.config?.systemPrompt).toBe("Be terse.");
      expect(v.config?.validation?.forbidden).toEqual(["I cannot help"]);
      expect(v.config?.contextLength).toBe(128000);
    }
  });
});

describe("orderComboTargets v2", () => {
  const ctx = {
    providerCalls: (pid: string) => (pid === "busy" ? 40 : 1),
    providerOf: (m: string) => m.split(":")[0]!,
    providerTier: () => 3,
    quotaShare: (m: string) => (m.startsWith("full") ? 0.9 : m.startsWith("low") ? 0.1 : null),
    cursor: 0,
  };
  it("headroom leads with the fullest quota", () => {
    const out = orderComboTargets("headroom", [{ model: "low:m" }, { model: "full:m" }, { model: "unk:m" }], ctx);
    expect(out[0]!.model).toBe("full:m");
    expect(out[out.length - 1]!.model).toBe("low:m");
  });
  it("strict-random keeps every target", () => {
    const out = orderComboTargets("strict-random", [{ model: "a:m" }, { model: "b:m" }], { ...ctx, random: () => 0.4 });
    expect(out).toHaveLength(2);
  });
});

describe("auto catalog", () => {
  const mk = (id: string, models: string[], costTier: number, authType?: string): ResolvedProvider =>
    ({
      id,
      name: id,
      baseUrl: `https://${id}.example/v1`,
      wireFormat: "openai",
      models,
      defaultModel: models[0],
      costTier,
      authType,
      apiKey: "k",
      allKeys: ["k"],
    }) as ResolvedProvider;

  it("classifies model capabilities", () => {
    expect(classifyModel("qwen2.5-coder-32b").coding).toBe(true);
    expect(classifyModel("deepseek-r1").reasoning).toBe(true);
    expect(classifyModel("gemini-2.5-flash").fast).toBe(true);
  });

  it("best-coding picks coder models; best-free sticks to cheap tiers", () => {
    const providers = [
      mk("prov-a", ["qwen-coder-32b", "plain-chat"], 4),
      mk("prov-b", ["llama-3.1-8b"], 1),
    ];
    const coding = buildAutoTargets(autoTemplate("auto/best-coding")!, providers);
    expect(coding.map((t) => t.model)).toContain("prov-a:qwen-coder-32b");
    const free = buildAutoTargets(autoTemplate("auto/best-free")!, providers);
    expect(free.every((t) => t.model.startsWith("prov-b:"))).toBe(true);
  });

  it("auto/best-fast resolves through the router", async () => {
    const fetchFn = (async () => jsonResponseAuto("auto-ok")) as unknown as typeof fetch;
    const router = createRouter([mk("prov-b", ["llama-flash-8b"], 1)]);
    const r = await router.route(
      { model: "auto/best-fast", messages: [{ role: "user", content: "hi" }] },
      { fetchFn },
    );
    expect(r.providerId).toBe("prov-b");
  });
});

function jsonResponseAuto(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "x",
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("router combo v2 behaviors", () => {
  function rprov(id: string, model: string, extra: Partial<ResolvedProvider> = {}): ResolvedProvider {
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
      ...extra,
    } as ResolvedProvider;
  }
  const bodyFor = (name: string) => ({
    model: name,
    messages: [{ role: "user" as const, content: "hi" }],
  });

  it("response validation fails over to the next target", async () => {
    const fetchFn = (async (url: string) =>
      String(url).includes("prov-a") ? jsonResponseAuto("I cannot help with that") : jsonResponseAuto("sure thing")) as typeof fetch;
    const router = createRouter([rprov("prov-a", "ma"), rprov("prov-b", "mb")], {
      combos: () => [
        {
          name: "guarded",
          kind: "router",
          strategy: "priority",
          targets: [{ model: "prov-a:ma" }, { model: "prov-b:mb" }],
          config: { validation: { forbidden: ["I cannot help"] } },
          createdAt: 1,
        },
      ],
    });
    const r = await router.route(bodyFor("guarded"), { fetchFn });
    expect(r.providerId).toBe("prov-b");
  });

  it("system prompt override replaces the system message", async () => {
    let seenSystem = "";
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<{ role: string; content: string }>;
      };
      seenSystem = parsed.messages.find((m) => m.role === "system")?.content ?? "";
      return jsonResponseAuto("ok");
    }) as typeof fetch;
    const router = createRouter([rprov("prov-a", "ma")], {
      combos: () => [
        {
          name: "terse",
          kind: "router",
          strategy: "priority",
          targets: [{ model: "prov-a:ma" }],
          config: { systemPrompt: "Be terse." },
          createdAt: 1,
        },
      ],
    });
    await router.route(
      {
        model: "terse",
        messages: [
          { role: "system", content: "Be verbose." },
          { role: "user", content: "hi" },
        ],
      },
      { fetchFn },
    );
    expect(seenSystem).toBe("Be terse.");
  });

  it("account pin forces the pinned key account", async () => {
    const seen: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push(h.authorization ?? h.Authorization ?? "");
      return jsonResponseAuto("ok");
    }) as typeof fetch;
    const prov = rprov("prov-a", "ma", {
      apiKey: "key-one",
      allKeys: ["key-one", "key-two"],
      keyAccounts: new Map([
        ["key-one", "acct_1"],
        ["key-two", "acct_2"],
      ]),
    });
    const router = createRouter([prov], {
      combos: () => [
        {
          name: "pinned",
          kind: "router",
          strategy: "priority",
          targets: [{ model: "prov-a:ma", accountId: "acct_2" }],
          createdAt: 1,
        },
      ],
    });
    await router.route(bodyFor("pinned"), { fetchFn });
    expect(seen).toEqual(["Bearer key-two"]);
  });

  it("disabled combos are not resolved as combos", async () => {
    let injected = false;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<{ role: string; content: string }>;
      };
      if (parsed.messages.some((m) => m.content === "COMBO-MARKER")) injected = true;
      return jsonResponseAuto("ok");
    }) as typeof fetch;
    const router = createRouter([rprov("prov-a", "ma")], {
      combos: () => [
        {
          name: "off",
          kind: "router",
          strategy: "priority",
          targets: [{ model: "prov-a:ma" }],
          config: { systemPrompt: "COMBO-MARKER" },
          enabled: false,
          createdAt: 1,
        },
      ],
    });
    await router.route(bodyFor("off"), { fetchFn }).catch(() => {});
    expect(injected).toBe(false);
  });
});

describe("auto catalog provider diversity", () => {
  const mk = (id: string, models: string[], costTier: number): ResolvedProvider =>
    ({
      id,
      name: id,
      baseUrl: `https://${id}.example/v1`,
      wireFormat: "openai",
      models,
      defaultModel: models[0],
      costTier,
      apiKey: "k",
      allKeys: ["k"],
    }) as ResolvedProvider;

  it("caps any single provider at 3 of the 6 candidate slots", () => {
    const big = mk(
      "big",
      ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-chat", "gpt-5-pro", "gpt-5-turbo"],
      3,
    );
    const small = mk("small", ["llama-flash-8b", "qwen-flash", "gemini-flash-lite"], 3);
    const targets = buildAutoTargets(autoTemplate("auto/best-chat")!, [big, small]);
    const fromBig = targets.filter((t) => t.model.startsWith("big:")).length;
    const fromSmall = targets.filter((t) => t.model.startsWith("small:")).length;
    expect(fromBig).toBeLessThanOrEqual(3);
    expect(fromSmall).toBeGreaterThanOrEqual(2);
    expect(targets.length).toBe(6);
  });

  it("backfills from the dominant provider when alternatives run out", () => {
    const big = mk(
      "big",
      ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-chat", "gpt-5-pro", "gpt-5-turbo"],
      3,
    );
    const targets = buildAutoTargets(autoTemplate("auto/best-chat")!, [big]);
    expect(targets.length).toBe(6);
    expect(targets.every((t) => t.model.startsWith("big:"))).toBe(true);
  });
});

describe("auto catalog category backfill", () => {
  const mk = (id: string, models: string[], costTier: number, authType?: string): ResolvedProvider =>
    ({
      id,
      name: id,
      baseUrl: `https://${id}.example/v1`,
      wireFormat: "openai",
      models,
      defaultModel: models[0],
      costTier,
      authType,
      apiKey: "k",
      allKeys: ["k"],
    }) as ResolvedProvider;

  it("best-coding backfills with strong general models when specialists are scarce", () => {
    const providers = [
      mk("wall", ["gpt-5.3-codex"], 4),
      mk("agy", ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gemini-3.8-flash-high"], 4, "oauth"),
    ];
    const targets = buildAutoTargets(autoTemplate("auto/best-coding")!, providers);
    expect(targets.length).toBe(4);
    // the one true specialist stays first
    expect(targets[0]!.model).toBe("wall:gpt-5.3-codex");
    // general frontier models fill the remaining slots
    expect(targets.map((t) => t.model)).toContain("agy:claude-sonnet-4-6");
    expect(targets.map((t) => t.model)).toContain("agy:gemini-3.8-flash-high");
  });

  it("best-vision does NOT backfill with non-vision models", () => {
    const providers = [mk("txt", ["llama-3.3-70b", "deepseek-chat"], 3)];
    const targets = buildAutoTargets(autoTemplate("auto/best-vision")!, providers);
    expect(targets).toHaveLength(0);
  });
});
