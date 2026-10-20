import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VertexAuthError,
  buildVertexJwt,
  clearVertexTokenCache,
  executeVertexChat,
  getVertexAccessToken,
  hasVertexCreds,
  resolveVertexConfig,
  vertexChatUrl,
  type VertexServiceAccount,
} from "../src/executor/vertex.js";
import type { ResolvedProvider } from "../src/providers/types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

const SA: VertexServiceAccount = {
  clientEmail: "svc@proj-1.iam.gserviceaccount.com",
  privateKey: PRIVATE_PEM,
  privateKeyId: "key-id-1",
  projectId: "proj-1",
};

const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "proj-1",
  private_key_id: "key-id-1",
  private_key: PRIVATE_PEM,
  client_email: "svc@proj-1.iam.gserviceaccount.com",
});

const fakeProvider = {
  id: "vertex",
  name: "Google Vertex AI",
  baseUrl: "https://us-central1-aiplatform.googleapis.com",
  wireFormat: "openai",
  models: [],
  defaultModel: "gemini-2.5-flash",
  costTier: 3,
  apiKey: "oauth",
} as ResolvedProvider;

describe("Vertex service-account JWT", () => {
  const now = 1_700_000_000;
  const { header, claims, jwt } = buildVertexJwt(SA, now);

  it("has the RFC 7523 shape OmniRoute mints", () => {
    expect(header).toMatchObject({ alg: "RS256", typ: "JWT", kid: "key-id-1" });
    expect(claims.iss).toBe("svc@proj-1.iam.gserviceaccount.com");
    expect(claims.sub).toBe("svc@proj-1.iam.gserviceaccount.com");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.iat).toBe(now);
    expect(claims.exp).toBe(now + 3600);
    expect(String(claims.scope)).toContain("https://www.googleapis.com/auth/cloud-platform");
  });

  it("carries a verifiable RS256 signature", () => {
    const [h, c, sig] = jwt.split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${h}.${c}`);
    verify.end();
    const ok = verify.verify(
      PUBLIC_PEM,
      Buffer.from(sig!.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    expect(ok).toBe(true);
  });
});

describe("Vertex token exchange (mock fetch)", () => {
  it("posts the jwt-bearer grant and caches the token", async () => {
    clearVertexTokenCache();
    const bodies: string[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ access_token: "ya29.test-token", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const tok1 = await getVertexAccessToken(SA, fetchFn);
    const tok2 = await getVertexAccessToken(SA, fetchFn);
    expect(tok1).toBe("ya29.test-token");
    expect(tok2).toBe("ya29.test-token");
    expect(bodies.length).toBe(1); // second call served from cache
    const params = new URLSearchParams(bodies[0]);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(params.get("assertion")?.split(".").length).toBe(3);
  });

  it("surfaces exchange failures as a typed auth error", async () => {
    clearVertexTokenCache();
    const fetchFn = (async () =>
      new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    await expect(getVertexAccessToken({ ...SA, clientEmail: "other@x.iam.gserviceaccount.com" }, fetchFn))
      .rejects.toThrow(VertexAuthError);
  });
});

describe("Vertex config resolution", () => {
  it("reads a service account from the GOOGLE_APPLICATION_CREDENTIALS file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vertex-sa-"));
    const file = join(dir, "sa.json");
    writeFileSync(file, SA_JSON);
    const cfg = resolveVertexConfig({ GOOGLE_APPLICATION_CREDENTIALS: file } as NodeJS.ProcessEnv);
    expect(cfg.projectId).toBe("proj-1");
    expect(cfg.region).toBe("us-central1");
    expect(cfg.serviceAccount?.clientEmail).toBe("svc@proj-1.iam.gserviceaccount.com");
    expect(hasVertexCreds({ GOOGLE_APPLICATION_CREDENTIALS: file } as NodeJS.ProcessEnv)).toBe(true);
  });

  it("inline JSON + project/region overrides win", () => {
    const cfg = resolveVertexConfig({
      VERTEX_SERVICE_ACCOUNT_JSON: SA_JSON,
      VERTEX_PROJECT_ID: "override-proj",
      VERTEX_REGION: "europe-west4",
    } as NodeJS.ProcessEnv);
    expect(cfg.projectId).toBe("override-proj");
    expect(cfg.region).toBe("europe-west4");
  });

  it("rejects an OAuth client JSON and missing creds", () => {
    expect(() =>
      resolveVertexConfig({
        VERTEX_SERVICE_ACCOUNT_JSON: JSON.stringify({ web: { client_id: "x" } }),
      } as NodeJS.ProcessEnv),
    ).toThrow(/not a service account key/);
    expect(hasVertexCreds({} as NodeJS.ProcessEnv)).toBe(false);
    expect(() => resolveVertexConfig({} as NodeJS.ProcessEnv)).toThrow(VertexAuthError);
  });

  it("builds the OpenAI-compatible endpoint URL", () => {
    expect(vertexChatUrl("proj-1", "us-central1")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-central1/endpoints/openapi/chat/completions",
    );
    expect(vertexChatUrl("proj-1", "global")).toBe(
      "https://aiplatform.googleapis.com/v1/projects/proj-1/locations/global/endpoints/openapi/chat/completions",
    );
  });
});

describe("executeVertexChat (mock fetch)", () => {
  it("sends the pre-minted token to the project endpoint", async () => {
    let seen: { url: string; init: any } | null = null;
    const fetchFn = (async (url: any, init: any) => {
      seen = { url: String(url), init };
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "gemini-2.5-flash",
          choices: [{ index: 0, message: { role: "assistant", content: "gm" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await executeVertexChat(
      fakeProvider,
      "gemini-2.5-flash",
      { model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] },
      fetchFn,
      5_000,
      { VERTEX_ACCESS_TOKEN: "ya29.pre", VERTEX_PROJECT_ID: "proj-9" } as NodeJS.ProcessEnv,
    );
    expect(out.response?.choices[0]!.message.content).toBe("gm");
    expect(seen!.url).toContain("/v1/projects/proj-9/locations/us-central1/endpoints/openapi/chat/completions");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer ya29.pre");
  });
});
