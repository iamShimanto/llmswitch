import { describe, expect, it } from "vitest";
import { CookieJar } from "../src/cookieJar.js";
import { GeminiWebDriver, parseGeminiResponse } from "../src/providers/webchat/gemini-web.js";

function jarWithCookies(): CookieJar {
  const jar = new CookieJar();
  jar.load("__Secure-1PSID=psid123; __Secure-1PSIDTS=ts456", "gemini.google.com");
  return jar;
}

function streamBody(candidate: unknown[]): string {
  const inner = JSON.stringify([null, ["c1", "r1"], null, null, [candidate]]);
  const outer = JSON.stringify([["wrb.fr", null, inner]]);
  return `)]}'\n${outer.length}\n${outer}\n`;
}

function mockFetch(imageBytes?: Uint8Array): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u === "https://gemini.google.com/app") {
      return new Response('<html>"SNlM0e":"tok-abc" and "cfb2h":"bl-label-1"</html>', { status: 200 });
    }
    if (u.includes("StreamGenerate")) {
      const cand: unknown[] = [];
      cand[1] = ["Hello from Gemini"];
      if (imageBytes) {
        const ext: unknown[] = [];
        ext[7] = [[[[null, null, null, "https://lh3.googleusercontent.com/generated-img"]]]];
        cand[12] = ext;
      }
      return new Response(streamBody(cand), { status: 200 });
    }
    if (u === "https://lh3.googleusercontent.com/generated-img") {
      return new Response(Buffer.from(imageBytes ?? []), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("gemini-web driver", () => {
  it("bootstraps SNlM0e from /app and chats via StreamGenerate", async () => {
    const driver = new GeminiWebDriver(jarWithCookies(), mockFetch());
    const text = await driver.chat("gemini-3.1-pro", [{ role: "user", content: "hi" }]);
    expect(text).toBe("Hello from Gemini");
  });

  it("parses candidates defensively (text at [1], images deep-scanned)", () => {
    const cand: unknown[] = [];
    cand[1] = ["a reply"];
    const ext: unknown[] = [];
    ext[7] = [[[[null, null, null, "https://lh3.googleusercontent.com/x"]]]];
    cand[12] = ext;
    const turn = parseGeminiResponse(streamBody(cand));
    expect(turn.text).toBe("a reply");
    expect(turn.imageUrls).toEqual(["https://lh3.googleusercontent.com/x"]);
  });

  it("generateImage downloads the returned image URL with cookies", async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    const driver = new GeminiWebDriver(jarWithCookies(), mockFetch(bytes));
    const img = await driver.generateImage("draw a cat");
    expect(img.mime).toBe("image/jpeg");
    expect(Buffer.from(img.b64, "base64")).toEqual(Buffer.from(bytes));
  });

  it("fails honestly when the session is not logged in", async () => {
    const noAt = (async (url: string) => {
      if (String(url) === "https://gemini.google.com/app") return new Response("<html>sign in</html>", { status: 200 });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const driver = new GeminiWebDriver(jarWithCookies(), noAt);
    await expect(driver.chat("gemini-3.1-pro", [{ role: "user", content: "hi" }])).rejects.toThrow(/SNlM0e|not logged in/);
  });
});
