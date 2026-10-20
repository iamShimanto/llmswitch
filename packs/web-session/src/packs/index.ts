import { WebSessionProvider } from "../base.js";
import { loadAntigravitySession } from "../providers/antigravity.js";

/**
 * Pack manifest: metadata + requirements for each web-session provider.
 * Status is EXPERIMENTAL for all: these drive unofficial web endpoints with
 * the user's own session. Read the ToS warning before enabling.
 */

export interface WebSessionPack {
  id: string;
  name: string;
  status: "experimental";
  tosWarning: string;
  /** env vars the user must set (cookie export or OAuth refresh token) */
  requiredEnv: string[];
  setupHint: string;
}

const TOS =
  "EXPERIMENTAL — uses your own browser session against an unofficial web endpoint. " +
  "This may violate the provider's Terms of Service; accounts can be limited or banned. " +
  "Sessions break when the provider changes its web app. Use at your own risk, " +
  "prefer official API providers for anything important.";

export const PACKS: WebSessionPack[] = [
  {
    id: "antigravity",
    name: "Google Antigravity (OAuth)",
    status: "experimental",
    tosWarning: TOS,
    requiredEnv: [],
    setupHint:
      "Run `llmswitch login antigravity` (browser OAuth) or set ANTIGRAVITY_OAUTH_REFRESH_TOKEN " +
      "and run `llmswitch login antigravity --refresh-token <rt>`. Unofficial flow — see ToS warning.",
  },
  {
    id: "claude-web",
    name: "Claude Web (cookie session)",
    status: "experimental",
    tosWarning: TOS,
    requiredEnv: ["CLAUDE_WEB_COOKIES"],
    setupHint: "Export cookies from a logged-in claude.ai session (Netscape format or raw header).",
  },
  {
    id: "chatgpt-web",
    name: "ChatGPT Web (cookie session)",
    status: "experimental",
    tosWarning: TOS,
    requiredEnv: ["CHATGPT_WEB_COOKIES"],
    setupHint: "Export cookies from a logged-in chatgpt.com session (Netscape format or raw header).",
  },
  {
    id: "copilot-web",
    name: "Copilot Web (cookie session)",
    status: "experimental",
    tosWarning: TOS,
    requiredEnv: ["COPILOT_WEB_COOKIES"],
    setupHint: "Export cookies from a logged-in copilot.microsoft.com session.",
  },
  {
    id: "grok-web",
    name: "Grok Web (cookie session)",
    status: "experimental",
    tosWarning: TOS,
    requiredEnv: ["GROK_WEB_COOKIES"],
    setupHint: "Export cookies from a logged-in grok.com session.",
  },
];

/** Experimental provider skeletons — protocol details need a live session to verify. */
export class AntigravityWeb extends WebSessionProvider {
  readonly id = "antigravity";
  readonly name = "Google Antigravity (OAuth)";
  loadSession(env: NodeJS.ProcessEnv): void {
    // Real integration lives in src/providers/antigravity.ts: session is
    // valid when `llmswitch login antigravity` saved one, or a refresh
    // token was provided directly via env.
    if (loadAntigravitySession()) return;
    if (!env.ANTIGRAVITY_OAUTH_REFRESH_TOKEN) {
      throw new Error(
        "no antigravity session — run: llmswitch login antigravity (or set ANTIGRAVITY_OAUTH_REFRESH_TOKEN)",
      );
    }
  }
}

export class ClaudeWeb extends WebSessionProvider {
  readonly id = "claude-web";
  readonly name = "Claude Web (cookie session)";
  loadSession(env: NodeJS.ProcessEnv): void {
    const c = env.CLAUDE_WEB_COOKIES;
    if (!c) throw new Error("CLAUDE_WEB_COOKIES is required");
    this.jar.load(c, "claude.ai");
  }
}

export class ChatGptWeb extends WebSessionProvider {
  readonly id = "chatgpt-web";
  readonly name = "ChatGPT Web (cookie session)";
  loadSession(env: NodeJS.ProcessEnv): void {
    const c = env.CHATGPT_WEB_COOKIES;
    if (!c) throw new Error("CHATGPT_WEB_COOKIES is required");
    this.jar.load(c, "chatgpt.com");
  }
}

export class CopilotWeb extends WebSessionProvider {
  readonly id = "copilot-web";
  readonly name = "Copilot Web (cookie session)";
  loadSession(env: NodeJS.ProcessEnv): void {
    const c = env.COPILOT_WEB_COOKIES;
    if (!c) throw new Error("COPILOT_WEB_COOKIES is required");
    this.jar.load(c, "copilot.microsoft.com");
  }
}

export class GrokWeb extends WebSessionProvider {
  readonly id = "grok-web";
  readonly name = "Grok Web (cookie session)";
  loadSession(env: NodeJS.ProcessEnv): void {
    const c = env.GROK_WEB_COOKIES;
    if (!c) throw new Error("GROK_WEB_COOKIES is required");
    this.jar.load(c, "grok.com");
  }
}
