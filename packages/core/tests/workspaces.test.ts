import { describe, expect, it } from "vitest";
import { memoryStore } from "../src/store/db.js";

describe("workspaces", () => {
  it("default workspace always exists", () => {
    const s = memoryStore();
    const ws = s.listWorkspaces();
    expect(ws.find((w) => w.id === "default")).toBeDefined();
    s.close();
  });

  it("create + assign key + spend", () => {
    const s = memoryStore();
    const ws = s.createWorkspace("acme");
    expect(ws.name).toBe("acme");

    const { record } = s.createApiKey("k1", 600, null, ws.id);
    expect(record.workspaceId).toBe(ws.id);

    s.logUsage({
      keyId: record.id, provider: "groq", model: "m",
      promptTokens: 100, completionTokens: 50, latencyMs: 10,
      status: "ok", costUsd: 0.001,
    });
    expect(s.workspaceSpend(ws.id, 0)).toBeCloseTo(0.001, 6);
    expect(s.workspaceSpend("default", 0)).toBe(0);

    expect(s.setKeyWorkspace(record.id, "default")).toBe(true);
    expect(s.workspaceSpend("default", 0)).toBeCloseTo(0.001, 6);
    s.close();
  });

  it("rejects unknown workspace", () => {
    const s = memoryStore();
    const { record } = s.createApiKey("k1");
    expect(s.setKeyWorkspace(record.id, "nope")).toBe(false);
    s.close();
  });

  it("keys default to the default workspace", () => {
    const s = memoryStore();
    const { record } = s.createApiKey("k1");
    expect(record.workspaceId).toBe("default");
    s.close();
  });
});
