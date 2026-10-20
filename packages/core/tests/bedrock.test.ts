import { describe, expect, it } from "vitest";
import {
  BedrockAuthError,
  bedrockConverseUrl,
  executeBedrockChat,
  fromConverseResponse,
  hasBedrockCreds,
  normalizeBedrockRegion,
  resolveBedrockCreds,
  signSigV4,
  toConverseBody,
} from "../src/executor/bedrock.js";
import type { ResolvedProvider } from "../src/providers/types.js";

const AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "eu-west-1",
} as NodeJS.ProcessEnv;

const fakeProvider = {
  id: "bedrock",
  name: "AWS Bedrock",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  wireFormat: "openai",
  models: [],
  defaultModel: "anthropic.claude-sonnet-4-6",
  costTier: 3,
  apiKey: "oauth",
} as ResolvedProvider;

describe("SigV4 signer (known-answer, AWS documentation vector)", () => {
  // AWS docs "Create a signed AWS API request" example:
  // GET https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08
  const result = signSigV4({
    method: "GET",
    host: "iam.amazonaws.com",
    path: "/",
    query: "Action=ListUsers&Version=2010-05-08",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    payload: "",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "iam",
    amzDate: "20150830T123600Z",
  });

  it("reproduces the documented canonical-request hash", () => {
    expect(result.canonicalRequestHash).toBe(
      "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
    );
  });

  it("reproduces the documented signature", () => {
    expect(result.signature).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(result.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("adds the session-token header when a token is present", () => {
    const signed = signSigV4({
      method: "POST",
      host: "bedrock-runtime.us-east-1.amazonaws.com",
      path: "/model/x/converse",
      headers: { "content-type": "application/json" },
      payload: "{}",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "SESSION",
      region: "us-east-1",
      service: "bedrock",
      amzDate: "20260101T000000Z",
    });
    expect(signed.headers["x-amz-security-token"]).toBe("SESSION");
    expect(signed.authorization).toContain("Credential=AK/20260101/us-east-1/bedrock/aws4_request");
  });
});

describe("bedrock credentials", () => {
  it("resolves env creds with region + session token", () => {
    const creds = resolveBedrockCreds({ ...AWS_ENV, AWS_SESSION_TOKEN: "tok" });
    expect(creds).toEqual({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      sessionToken: "tok",
      region: "eu-west-1",
    });
    expect(hasBedrockCreds(AWS_ENV)).toBe(true);
  });

  it("defaults region to us-east-1 and rejects junk regions", () => {
    expect(resolveBedrockCreds({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }).region).toBe("us-east-1");
    expect(normalizeBedrockRegion("not a region")).toBe("us-east-1");
    expect(normalizeBedrockRegion("EU-WEST-2")).toBe("eu-west-2");
  });

  it("throws a typed error naming the env vars when creds are missing", () => {
    expect(hasBedrockCreds({})).toBe(false);
    expect(() => resolveBedrockCreds({})).toThrow(BedrockAuthError);
    expect(() => resolveBedrockCreds({})).toThrow(/AWS_ACCESS_KEY_ID/);
  });
});

describe("Converse mapping", () => {
  it("extracts system + inferenceConfig and keeps roles", () => {
    const body = toConverseBody("anthropic.claude-sonnet-4-6", {
      model: "anthropic.claude-sonnet-4-6",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      max_tokens: 512,
      temperature: 0.2,
    });
    expect(body.system).toEqual([{ text: "be brief" }]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
      { role: "assistant", content: [{ text: "hello" }] },
    ]);
    expect(body.inferenceConfig).toEqual({ maxTokens: 512, temperature: 0.2 });
  });

  it("maps stopReason + usage (incl. cache tokens)", () => {
    const res = fromConverseResponse(
      {
        output: { message: { content: [{ text: "done" }] } },
        stopReason: "max_tokens",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 20, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 },
      },
      "m",
    );
    expect(res.choices[0]!.message.content).toBe("done");
    expect(res.choices[0]!.finish_reason).toBe("length");
    expect(res.usage).toEqual({ prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 });
  });

  it("builds the runtime URL with an encoded model id", () => {
    expect(bedrockConverseUrl("us-east-1", "anthropic.claude-sonnet-4-6")).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-sonnet-4-6/converse",
    );
  });
});

describe("executeBedrockChat (mock fetch)", () => {
  it("signs the request and maps the response", async () => {
    let seen: { url: string; init: any } | null = null;
    const fetchFn = (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(
        JSON.stringify({
          output: { message: { content: [{ text: "signed!" }] } },
          stopReason: "end_turn",
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await executeBedrockChat(
      fakeProvider,
      "anthropic.claude-sonnet-4-6",
      { model: "anthropic.claude-sonnet-4-6", messages: [{ role: "user", content: "ping" }] },
      fetchFn,
      5_000,
      AWS_ENV,
    );
    expect(out.response?.choices[0]!.message.content).toBe("signed!");
    expect(seen!.url).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-sonnet-4-6/converse",
    );
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=accept;content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    const sentBody = JSON.parse(seen!.init.body as string);
    expect(sentBody.messages).toEqual([{ role: "user", content: [{ text: "ping" }] }]);
  });

  it("rejects when creds are missing (typed, before any fetch)", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await expect(
      executeBedrockChat(
        fakeProvider,
        "anthropic.claude-sonnet-4-6",
        { model: "m", messages: [{ role: "user", content: "x" }] },
        fetchFn,
        5_000,
        {} as NodeJS.ProcessEnv,
      ),
    ).rejects.toThrow(BedrockAuthError);
    expect(called).toBe(false);
  });

  it("refuses streaming (binary event-stream not ported)", async () => {
    await expect(
      executeBedrockChat(
        fakeProvider,
        "anthropic.claude-sonnet-4-6",
        { model: "m", messages: [{ role: "user", content: "x" }], stream: true },
        fetch,
        5_000,
        AWS_ENV,
      ),
    ).rejects.toThrow(/streaming is not supported/);
  });
});
