"use strict";

// Web-session (cookie) providers from the LLMSwitch registry: id → site domain.
const PROVIDERS = [
  ["blackbox", "Blackbox AI", "app.blackbox.ai"],
  ["chatgpt-web", "ChatGPT Web", "chatgpt.com"],
  ["chatgpt-web-free", "ChatGPT Web (free)", "chatgpt.com"],
  ["claude-web", "Claude Web", "claude.ai"],
  ["claude-web-cookie", "Claude Web (cookie)", "claude.ai"],
  ["copilot-web", "Copilot Web", "copilot.microsoft.com"],
  ["deepai", "DeepAI", "deepai.org"],
  ["deepseek-web", "DeepSeek Web", "chat.deepseek.com"],
  ["duckduckgo", "DuckDuckGo AI Chat", "duckduckgo.com"],
  ["grok-web", "Grok Web", "grok.com"],
  ["huggingchat", "HuggingChat", "huggingface.co"],
  ["lmarena", "LMArena", "arena.ai"],
  ["manus", "Manus", "manus.im"],
  ["poe", "Poe", "poe.com"],
  ["venice-web", "Venice Web", "venice.ai"],
  ["you-com-web", "You.com Web", "you.com"],
  ["muse-spark-web", "Muse Spark (Meta AI)", "meta.ai"],
];

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === true ? "ok" : ok === false ? "err" : "";
}

async function init() {
  const sel = $("provider");
  for (const [id, name] of PROVIDERS) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  const saved = await chrome.storage.local.get(["gateway", "token", "provider"]);
  if (saved.gateway) $("gateway").value = saved.gateway;
  if (saved.token) $("token").value = saved.token;
  if (saved.provider) sel.value = saved.provider;
  for (const el of ["gateway", "token", "provider"]) {
    $(el).addEventListener("change", () => {
      chrome.storage.local.set({
        gateway: $("gateway").value.trim(),
        token: $("token").value.trim(),
        provider: sel.value,
      });
    });
  }
  $("connect").addEventListener("click", connect);
}

async function connect() {
  const gateway = $("gateway").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  const providerId = $("provider").value;
  const domain = PROVIDERS.find((p) => p[0] === providerId)[2];
  if (!gateway || !token) {
    setStatus("Set the gateway URL and your admin key / session token first.", false);
    return;
  }
  const btn = $("connect");
  btn.disabled = true;
  setStatus("Reading cookies for " + domain + "…");
  try {
    const cookies = await chrome.cookies.getAll({ domain });
    if (!cookies || cookies.length === 0) {
      setStatus(
        "No cookies found for " + domain + ". Open the site in this browser and log in first.",
        false,
      );
      return;
    }
    const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    // Meta AI additionally needs the short-lived ecto1 access token embedded
    // in the meta.ai page HTML. Fetch it in THIS browser (logged in, no JS
    // challenge) and ship it with the session.
    let accessToken;
    if (providerId === "muse-spark-web") {
      try {
        setStatus("Grabbing the Meta AI access token…");
        const page = await fetch("https://www.meta.ai/", { credentials: "include" });
        const html = await page.text();
        const m = html.match(/accessToken[\\"]+:\s*[\\"]+ecto1:([A-Za-z0-9_-]+)[\\"]+/);
        if (m) accessToken = "ecto1:" + m[1];
      } catch {
        /* token stays unset — the gateway will explain on first use */
      }
    }
    const res = await fetch(gateway + "/api/sessions/import", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": token,
        "x-dashboard-session": token,
      },
      body: JSON.stringify({
        provider: providerId,
        cookies: header,
        cookieDomain: domain,
        ...(accessToken ? { accessToken } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.connected) {
      setStatus("✓ Connected! " + providerId + " is live in your gateway now.", true);
    } else if (res.ok) {
      setStatus(
        "Session saved, but the provider did not connect — the login may be incomplete. Make sure you are fully logged in on the site, then try again.",
        false,
      );
    } else {
      setStatus(
        "Gateway error " + res.status + ": " + ((data.error && data.error.message) || "unknown"),
        false,
      );
    }
  } catch (err) {
    setStatus("Failed: " + err.message, false);
  } finally {
    btn.disabled = false;
  }
}

init();
