/**
 * LLMSwitch browser bridge — executes ChatGPT Web turns inside a real
 * headless Chrome so the page's own Sentinel/Turnstile machinery mints
 * its tokens invisibly (a headless HTTP client cannot mint the
 * Turnstile token; from a real browser on the same host the flow
 * completes — verified live on the production VPS).
 *
 * API:
 *   GET  /health      → { ok: true }
 *   POST /turn        → { prompt, cookies?, timeoutMs? }
 *                       { ok: true, text } | { ok: false, error }
 *
 * One browser, turns serialized (the host is small; a single page at a
 * time keeps RAM bounded). Each turn runs in a fresh browser context so
 * cookies never leak between accounts. Prompts are never logged.
 */
import { createServer } from "node:http";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.PORT || 6100);
const CHROME = process.env.CHROME_PATH || "/opt/chrome/chrome-linux64/chrome";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: CHROME,
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-crashpad",
          "--no-first-run",
          "--window-size=1280,900",
        ],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// Serialize turns: one page at a time.
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCookies(header) {
  if (!header || typeof header !== "string") return [];
  return header
    .split(/;\s*/)
    .filter((kv) => kv.includes("="))
    .map((kv) => {
      const i = kv.indexOf("=");
      return {
        name: kv.slice(0, i).trim(),
        value: kv.slice(i + 1).trim(),
        url: "https://chatgpt.com",
      };
    })
    .filter((c) => c.name);
}

const EXTRACT_ASSISTANT = () => {
  // Desktop layout: role-marked message nodes.
  const nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (nodes.length) return (nodes[nodes.length - 1].innerText || "").trim();
  const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
  if (turns.length) return (turns[turns.length - 1].innerText || "").trim();
  // Anonymous/mobile-web layout (verified live): no role nodes at all —
  // the transcript is plain text: "You said: <prompt> ChatGPT said:
  // <answer>" followed by footer chrome. Slice the answer out of it.
  const text = document.body?.innerText ?? "";
  const youIdx = text.lastIndexOf("You said:");
  const saidIdx = text.indexOf("ChatGPT said:", youIdx >= 0 ? youIdx : 0);
  if (saidIdx < 0) return "";
  let answer = text.slice(saidIdx + "ChatGPT said:".length);
  for (const marker of ["ChatGPT is AI", "Chat with ChatGPT"]) {
    const cut = answer.indexOf(marker);
    if (cut >= 0) answer = answer.slice(0, cut);
  }
  return answer.trim();
};

const PAGE_PROBLEM = () => {
  const text = document.body?.innerText ?? "";
  if (/verify you are human|just a moment|checking your browser/i.test(text))
    return "cloudflare challenge presented to the bridge browser";
  if (/log in to continue|you need to log in/i.test(text))
    return "chatgpt asks for a login — the session cookies are missing or expired";
  return null;
};

async function runTurn({ prompt, cookies, timeoutMs }) {
  const t0 = Date.now();
  const lap = (stage) => console.log(`[bridge] ${stage} +${Date.now() - t0}ms`);
  const budget = Math.min(Math.max(Number(timeoutMs) || 90_000, 10_000), 150_000);
  const browser = await getBrowser();
  lap("browser-ready");
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  try {
    await page.setUserAgent(UA);
    const parsed = parseCookies(cookies);
    if (parsed.length) await page.setCookie(...parsed);
    await page.goto("https://chatgpt.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    lap("page-loaded");
    const composer = await page.waitForSelector('textarea, [contenteditable="true"]', {
      timeout: 25_000,
    });
    if (!composer) throw new Error("composer not found on chatgpt.com");
    await sleep(800); // let the SPA finish its initial navigation/settling
    await composer.click();
    await page.keyboard.type(prompt, { delay: 8 });
    await sleep(600);
    // The send click races the SPA's navigation to /c/<id> — an evaluate
    // destroyed by that navigation is fine (the click may still have
    // landed); Enter is the fallback and the poll loop is the judge.
    let sent = false;
    try {
      sent = await page.evaluate(() => {
        const btn = document.querySelector(
          'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"]',
        );
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });
    } catch {
      sent = false;
    }
    if (!sent) await page.keyboard.press("Enter").catch(() => {});
    lap("sent");

    // Poll until the assistant text is non-empty and stable.
    const deadline = Date.now() + budget;
    let last = "";
    let stable = 0;
    while (Date.now() < deadline) {
      await sleep(1500);
      const problem = await page.evaluate(PAGE_PROBLEM).catch(() => null);
      if (problem) throw new Error(problem);
      const text = await page.evaluate(EXTRACT_ASSISTANT).catch(() => "");
      if (text && text === last) {
        stable++;
        if (stable >= 2) break;
      } else {
        stable = 0;
        if (text) last = text;
      }
    }
    if (!last) throw new Error("no assistant response rendered before the timeout");
    lap("answered");
    return last;
  } finally {
    await ctx.close().catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  };
  if (req.method === "GET" && req.url === "/health") {
    send(200, { ok: true });
    return;
  }
  if (req.method === "POST" && req.url === "/turn") {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 512_000) req.destroy();
    });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        send(400, { ok: false, error: "invalid JSON" });
        return;
      }
      if (!body.prompt || typeof body.prompt !== "string") {
        send(400, { ok: false, error: "prompt is required" });
        return;
      }
      try {
        // One automatic retry with a fresh browser context, but only for
        // FAST transient failures (navigation races, launch hiccups) —
        // retrying a full no-response attempt would just double the wait.
        const text = await enqueue(async () => {
          const started = Date.now();
          try {
            return await runTurn(body);
          } catch (err) {
            if (Date.now() - started > 30_000) throw err;
            console.log("[bridge] retrying after fast failure:", err.message);
            return await runTurn(body);
          }
        });
        send(200, { ok: true, text });
      } catch (err) {
        send(200, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
    return;
  }
  send(404, { ok: false, error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[browser-bridge] listening on :${PORT} (chrome: ${CHROME})`);
  // Pre-warm: the first cold Chrome launch on a small host can take
  // 10-30s (profile + font caches) — pay it at boot, not on a request.
  getBrowser()
    .then(() => console.log("[bridge] browser pre-warmed"))
    .catch((err) => console.error("[bridge] pre-warm failed:", err.message));
});
