import { describe, expect, it } from "vitest";
import {
  PromptQlAuthError,
  decodeJwtPayload,
  executePromptQlChat,
  extractFinalResponseMessage,
  extractPromptQlProjectId,
  resolvePromptQlModel,
  runPromptQlThread,
} from "../src/executor/promptql.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function makeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.sig`;
}

const PROJECT = "11111111-2222-3333-4444-555555555555";
const TOKEN = makeJwt({
  iss: "enrich-token",
  exp: Math.floor(Date.now() / 1000) + 3600,
  "https://promptql.hasura.io": { "x-hasura-project-id": PROJECT },
});

const fakeProvider = {
  id: "promptql",
  name: "PromptQL",
  baseUrl: "https://data.prompt.ql.app/promptql/playground-v2-hge/v1/graphql",
  wireFormat: "openai",
  models: [],
  defaultModel: "bedrock-claude-sonnet-4-5",
  costTier: 2,
  apiKey: TOKEN,
} as unknown as ResolvedProvider;

describe("promptql JWT helpers (ported from OmniRoute)", () => {
  it("decodes the payload and extracts the Hasura project id", () => {
    expect(decodeJwtPayload(TOKEN)?.iss).toBe("enrich-token");
    expect(extractPromptQlProjectId(TOKEN)).toBe(PROJECT);
  });

  it("falls back to project_id claim, then to a UUID aud", () => {
    expect(extractPromptQlProjectId(makeJwt({ project_id: "p-1" }))).toBe("p-1");
    expect(extractPromptQlProjectId(makeJwt({ aud: PROJECT }))).toBe(PROJECT);
    expect(() => extractPromptQlProjectId(makeJwt({ iss: "x" }))).toThrow(PromptQlAuthError);
    expect(() => extractPromptQlProjectId("not-a-jwt")).toThrow(PromptQlAuthError);
  });

  it("maps models to their llm_config UUIDs", () => {
    expect(resolvePromptQlModel("gemini-3.7-flash").configId).toBe(
      "60754535-a5e8-4ae7-acf2-43d046771700",
    );
    expect(resolvePromptQlModel("unknown-model").configId).toBe(
      "c47a1e57-2fca-4cfe-913a-5fb821079f50", // falls back to the first seed model
    );
  });
});

describe("promptql final-response extraction", () => {
  it("reads the final_response.message leaf", () => {
    const eventData = {
      event_type: "AgentMessage",
      final_response: { message: "the answer" },
      extra: { note: "final_response_sent" },
    };
    expect(extractFinalResponseMessage(eventData)).toBe("the answer");
  });

  it("unwraps <final_response> XML embedded in other text", () => {
    const eventData = { response_text: "thinking… <final_response>wrapped</final_response>" };
    expect(extractFinalResponseMessage(eventData)).toBe("wrapped");
  });
});

describe("promptql thread lifecycle (mock fetch)", () => {
  const finalEvent = {
    thread_event_id: 7,
    event_data: { kind: "final_response_sent", final_response: { message: "polled answer" } },
  };

  function mockGql(mode: "seeded" | "polled") {
    const calls: Array<{ operationName: string; variables: any; headers: any }> = [];
    const fetchFn = (async (_url: any, init: any) => {
      const reqBody = JSON.parse(String(init.body));
      calls.push({ operationName: reqBody.operationName, variables: reqBody.variables, headers: init.headers });
      if (reqBody.operationName === "StartThreadWithModel") {
        return new Response(
          JSON.stringify({
            data: {
              start_thread: {
                thread_id: "tid-1",
                thread_events: mode === "seeded" ? [finalEvent] : [],
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ data: { thread_events: [finalEvent] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it("returns the seeded final event without polling", async () => {
    const { calls, fetchFn } = mockGql("seeded");
    const text = await runPromptQlThread(TOKEN, PROJECT, "hello", "cfg-1", fetchFn, {
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(text).toBe("polled answer");
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.variables).toMatchObject({ projectId: PROJECT, llmConfigId: "cfg-1" });
  });

  it("polls QueryThreadEvents until the final event lands", async () => {
    const { calls, fetchFn } = mockGql("polled");
    const text = await runPromptQlThread(TOKEN, PROJECT, "hello", "cfg-1", fetchFn, {
      intervalMs: 0,
      sleep: async () => {},
    });
    expect(text).toBe("polled answer");
    expect(calls.map((c) => c.operationName)).toEqual(["StartThreadWithModel", "QueryThreadEvents"]);
    expect(calls[1]!.variables).toMatchObject({ thread_id: "tid-1", after_event_id: 0 });
  });

  it("executor maps the thread result into the OpenAI shape", async () => {
    const { fetchFn } = mockGql("seeded");
    const out = await executePromptQlChat(
      fakeProvider,
      "gemini-3.7-flash",
      { model: "gemini-3.7-flash", messages: [{ role: "user", content: "hi" }] },
      fetchFn,
      5_000,
      {} as NodeJS.ProcessEnv,
    );
    expect(out.providerId).toBe("promptql");
    expect(out.response?.choices[0]!.message.content).toBe("polled answer");
  });

  it("rejects an expired JWT before any network call", async () => {
    const expired = { ...fakeProvider, apiKey: makeJwt({ exp: 1000, "https://promptql.hasura.io": { "x-hasura-project-id": PROJECT } }) };
    await expect(
      executePromptQlChat(
        expired as ResolvedProvider,
        "gemini-3.7-flash",
        { model: "m", messages: [{ role: "user", content: "x" }] },
        fetch,
        5_000,
        {} as NodeJS.ProcessEnv,
      ),
    ).rejects.toThrow(/expired/);
  });
});
