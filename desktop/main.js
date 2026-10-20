/**
 * LLMSwitch desktop shell (Electron scaffold).
 * Starts the gateway in-process and opens the dashboard in a window.
 * Build installers with: npx electron-builder
 */
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

async function boot() {
  // start the gateway (uses PORT env or 6000)
  const { start } = require("@llmswitch/core");
  await start();
  const port = process.env.PORT || "6000";

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "LLMSwitch",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(boot);
app.on("window-all-closed", () => app.quit());
