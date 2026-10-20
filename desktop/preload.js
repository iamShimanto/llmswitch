// Preload: intentionally minimal — the dashboard needs no Node APIs.
const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("llmswitch", { version: "0.1.0" });
