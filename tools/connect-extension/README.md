# LLMSwitch Connect (browser extension)

One-click connect for LLMSwitch **web-session (cookie) providers** (ChatGPT Web,
Claude Web, Grok Web, Poe, …). Log in to the site in your browser, click Connect,
and your cookies are sent **only to your own gateway** — the provider shows up as
connected immediately. No DevTools, no manual copying.

## Install

**Desktop Chrome / Edge / Brave**

1. Download this folder (`tools/connect-extension`) from the repo.
2. Open `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select this folder.

**Android (Kiwi Browser)**

Kiwi Browser supports Chrome extensions: Menu → Extensions → enable developer
mode and load this folder (or a zip of it). Regular Chrome for Android does not
support extensions.

## Use

1. Open the provider's site in this browser and **log in** normally.
2. Click the LLMSwitch Connect icon.
3. Set your **Gateway URL** (e.g. `https://llmswitch.shimantosarkar.dev`) and your
   **admin key** (or a dashboard session token) — saved locally in the extension.
4. Pick the provider and press **Connect**.

## Notes

- Cookies are read with the extension `cookies` permission (this includes
  httpOnly cookies — that's what makes one-click possible) and are POSTed to
  `POST /api/sessions/import` on your gateway only.
- Web sessions are unofficial and can break when a site changes its web app.
  Re-run Connect to refresh them.
