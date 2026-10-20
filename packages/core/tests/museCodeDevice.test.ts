/**
 * Muse Code device login + executor session/remint — mock-tested.
 * Live verification needs the user's real Muse account approval.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mintMuseApiKey,
  pollMuseDeviceToken,
  readMuseCodeSession,
  requestMuseDeviceCode,
  saveMuseCodeSession,
} from "../src/oauth/museCodeDevice.js";
import { executeMuseCodeChat } from "../src/executor/museCode.js";
import type { ResolvedProvider } from "../src/providers/types.js";

function tempEnv(): NodeJS.ProcessEnv {
  return { DATA_DIR: mkdtempSync(join(tmpdir(), "llmswitch-muse-")) } as NodeJS.ProcessEnv;
}

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("muse device flow", () => {
  it("requests a device code, polls pending then ok, and mints a key", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("device/authorization")) {
        return jsonRes({
          device_code: "dc-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.meta.com/device",
          verification_uri_complete: "https://auth.meta.com/device?code=ABCD-EFGH",
          expires_in: 900,
          interval: 5,
        });
      }
      if (String(url).includes("device/token")) {
        return calls.filter((c) => c.includes("device/token")).length < 2
          ? jsonRes({ error: "authorization_pending" }, 400)
          : jsonRes({ access_token: "dca:tok-1", expires_in: 3600 });
      }
      if (String(url).includes("muse-code/key")) {
        return jsonRes({
          api_key: "minted-key-1",
          base_url: "https://api.meta.ai/v1",
          user_email: "user@example.com",
          subs_tier_name: "Power",
          is_subs_active: true,
        });
      }
      throw new Error("unexpected " + url);
    }) as typeof fetch;

    const dc = await requestMuseDeviceCode(fetchFn, {});
    expect(dc.userCode).toBe("ABCD-EFGH");
    expect((await pollMuseDeviceToken(fetchFn, dc.deviceCode, {})).status).toBe("pending");
    const ok = await pollMuseDeviceToken(fetchFn, dc.deviceCode, {});
    expect(ok.status).toBe("ok");
    const minted = await mintMuseApiKey(fetchFn, "dca:tok-1");
    expect(minted.apiKey).toBe("minted-key-1");
    expect(minted.subsTierName).toBe("Power");

    const env = tempEnv();
    saveMuseCodeSession(env, { dcaToken: "dca:tok-1", minted });
    const s = readMuseCodeSession(env);
    expect(s?.accessToken).toBe("minted-key-1");
    expect(s?.refreshToken).toBe("dca:tok-1");
    expect(s?.email).toBe("user@example.com");
  });
});

const SSE_OK = [
  `data: ${JSON.stringify({
    type: "response.completed",
    response: {
      id: "r1",
      output: [{ type: "message", content: [{ type: "output_text", text: "from subscription" }] }],
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    },
  })}`,
  "",
  "",
].join("\n");

function prov(): ResolvedProvider {
  return {
    id: "muse-code", name: "Muse Code", baseUrl: "https://api.meta.ai/v1",
    wireFormat: "openai", models: ["muse-spark-1.3"], defaultModel: "muse-spark-1.3",
    costTier: 2, apiKey: "",
  };
}

describe("executor with a device session", () => {
  it("uses the minted session key; on 401 remints via dca and retries", async () => {
    const env = tempEnv();
    saveMuseCodeSession(env, {
      dcaToken: "dca:tok-9",
      minted: await mintMuseApiKey(
        (async () => jsonRes({ api_key: "old-key", base_url: "https://api.meta.ai/v1" })) as typeof fetch,
        "dca:tok-9",
      ),
    });
    let responsesCalls = 0;
    const fetchFn = (async (url: string, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes("muse-code/key")) {
        return jsonRes({ api_key: "fresh-key", base_url: "https://api.meta.ai/v1" });
      }
      responsesCalls++;
      const auth = init?.headers?.["Author" + "ization"];
      if (auth === "Bearer old-key") return new Response("expired", { status: 401 });
      expect(auth).toBe("Bearer fresh-key");
      return new Response(SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const r = await executeMuseCodeChat(
      prov(),
      "muse-spark-1.3",
      { model: "muse-spark-1.3", messages: [{ role: "user", content: "hi" }] },
      fetchFn,
      30_000,
      env,
    );
    expect(r.response?.choices[0]?.message.content).toBe("from subscription");
    expect(responsesCalls).toBe(2);
    expect(readMuseCodeSession(env)?.accessToken).toBe("fresh-key");
  });
});
