import { describe, expect, it } from "vitest";
import { CODEX_NOT_ACTIVE_MESSAGE, codexTestError, parseCodexModelsPayload } from "../src/executor/codexOAuth.js";

describe("parseCodexModelsPayload", () => {
  it("accepts plain string entries", () => {
    expect(parseCodexModelsPayload({ models: ["gpt-5-codex", "codex-mini-latest"] })).toEqual([
      "gpt-5-codex",
      "codex-mini-latest",
    ]);
  });

  it("extracts ids from object entries (slug first, then id/model/name)", () => {
    expect(
      parseCodexModelsPayload({
        models: [
          { slug: "gpt-5-codex", display_name: "GPT-5 Codex" },
          { id: "gpt-5.1-codex" },
          { model: "gpt-5.2-codex" },
          { name: "codex-mini-latest" },
          { slug: "wins", id: "loses" },
        ],
      }),
    ).toEqual(["gpt-5-codex", "gpt-5.1-codex", "gpt-5.2-codex", "codex-mini-latest", "wins"]);
  });

  it("trims, dedupes and drops empties and junk entries", () => {
    expect(
      parseCodexModelsPayload({
        models: [
          "  gpt-5-codex ",
          "gpt-5-codex",
          "",
          "   ",
          42,
          null,
          undefined,
          {},
          { slug: "" },
          { slug: 7 },
          [],
          { slug: " codex-mini-latest" },
        ],
      }),
    ).toEqual(["gpt-5-codex", "codex-mini-latest"]);
  });

  it("returns [] for an empty models list (account without Codex)", () => {
    expect(parseCodexModelsPayload({ models: [] })).toEqual([]);
  });

  it("returns [] for wrong-shaped payloads", () => {
    expect(parseCodexModelsPayload(null)).toEqual([]);
    expect(parseCodexModelsPayload(undefined)).toEqual([]);
    expect(parseCodexModelsPayload("gpt-5-codex")).toEqual([]);
    expect(parseCodexModelsPayload(42)).toEqual([]);
    expect(parseCodexModelsPayload({})).toEqual([]);
    expect(parseCodexModelsPayload({ models: "gpt-5-codex" })).toEqual([]);
    expect(parseCodexModelsPayload({ data: [{ id: "gpt-5-codex" }] })).toEqual([]);
    expect(parseCodexModelsPayload([{ slug: "gpt-5-codex" }])).toEqual([]);
  });
});

describe("codexTestError", () => {
  it("replaces the unprovisioned-account upstream error with the activation message", () => {
    const raw =
      "all providers failed (tried: codex): codex upstream 400 Bad Request: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
    expect(codexTestError(raw)).toBe(CODEX_NOT_ACTIVE_MESSAGE);
  });

  it("leaves other errors unchanged", () => {
    const raw = "all providers failed (tried: codex): codex upstream 401 Unauthorized: token expired";
    expect(codexTestError(raw)).toBe(raw);
    expect(codexTestError("network timeout")).toBe("network timeout");
  });

  it("leaves an empty error unchanged", () => {
    expect(codexTestError("")).toBe("");
  });
});
