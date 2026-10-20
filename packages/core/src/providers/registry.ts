import { BUILTIN_PROVIDERS } from "./builtins.js";
import { CATALOG_PROVIDERS } from "./catalog.js";
import { hasAntigravityCreds } from "../executor/antigravity.js";
import { hasClaudeCreds } from "../executor/claudeOAuth.js";
import { hasCodexCreds } from "../executor/codexOAuth.js";
import { hasCopilotCreds } from "../executor/copilot.js";
import { hasCursorCreds } from "../executor/cursor.js";
import { hasKiroCreds } from "../executor/kiro.js";
import { hasTraeCreds } from "../executor/trae.js";
import { hasZedHostedCreds } from "../executor/zedHosted.js";
import { hasClinepassCreds } from "../executor/clinepass.js";
import {
  hasCodebuddyCnCreds,
  hasCodebuddyIntlCreds,
  hasWorkbuddyCreds,
  hasGrokCliCreds,
  hasOpenferenceCreds,
  hasGitlabDuoCreds,
  hasAgyCreds,
  hasDevinDesktopCreds,
  hasProviderSession,
} from "../oauth/sessions.js";
import { hasBedrockCreds } from "../executor/bedrock.js";
import { hasVertexCreds } from "../executor/vertex.js";
import { hasWebChatCreds, WEBCHAT_PROVIDER_IDS } from "../executor/webchat.js";
import { collectKeys } from "../accounts/index.js";
import type { ProviderDef, ResolvedProvider } from "./types.js";

/**
 * Credential availability checks for OAuth/token-import providers,
 * mirroring the web-session pack's session-file conventions. Tokens are
 * resolved at call time by each provider's executor.
 */
const OAUTH_CREDS_CHECKS: Record<string, (env: NodeJS.ProcessEnv) => boolean> = {
  antigravity: hasAntigravityCreds,
  claude: hasClaudeCreds,
  codex: hasCodexCreds,
  github: (env) => hasCopilotCreds(env, "github"),
  "ghe-copilot": (env) => hasCopilotCreds(env, "ghe-copilot"),
  cursor: hasCursorCreds,
  kiro: hasKiroCreds,
  trae: hasTraeCreds,
  "zed-hosted": hasZedHostedCreds,
  clinepass: hasClinepassCreds,
  "codebuddy-cn": hasCodebuddyCnCreds,
  "codebuddy-intl": hasCodebuddyIntlCreds,
  workbuddy: hasWorkbuddyCreds,
  "grok-cli": hasGrokCliCreds,
  openference: hasOpenferenceCreds,
  "gitlab-duo": hasGitlabDuoCreds,
  agy: hasAgyCreds,
  "devin-desktop": hasDevinDesktopCreds,
  // env-creds providers (P11-K): multi-part env credentials, executor-resolved
  bedrock: hasBedrockCreds,
  vertex: hasVertexCreds,
};

// Cookie web-session providers (P11-J): connected when an imported cookie
// session exists at ~/.llmswitch/sessions/<id>.json.
for (const id of WEBCHAT_PROVIDER_IDS) {
  OAUTH_CREDS_CHECKS[id] = (env) => hasWebChatCreds(id, env);
}

/**
 * Provider registry. A provider is "connected" when its API key env var is set.
 * Extra providers can be registered at runtime (used by tests and P1 catalog).
 */
export class ProviderRegistry {
  private defs: ProviderDef[] = [...BUILTIN_PROVIDERS, ...CATALOG_PROVIDERS];

  register(def: ProviderDef): void {
    this.defs = this.defs.filter((d) => d.id !== def.id);
    this.defs.push(def);
  }

  /** All providers with credentials resolved from the environment. */
  connected(env: NodeJS.ProcessEnv = process.env): ResolvedProvider[] {
    const out: ResolvedProvider[] = [];
    for (const def of this.defs) {
      // A disabled catalog entry (unported transport, local-CLI-only, …)
      // never connects, regardless of which auth branch it would take.
      if (def.disabled) continue;
      // OAuth/token-import providers don't key off envKey: they're connected
      // when a login session (or env token) exists. Tokens are resolved at
      // call time by their executor.
      if (def.authType === "oauth" || def.authType === "token-import" || def.authType === "env-creds" || def.authType === "cookie") {
        if (def.disabled) continue; // e.g. local-CLI-only transports
        const check = OAUTH_CREDS_CHECKS[def.id];
        const available = check ? check(env) : collectKeys(def.envKey, env).length > 0;
        if (!available) continue;
        const { envKey: _ek, envBaseUrl: _eb, ...rest } = def;
        out.push({
          ...rest,
          apiKey: "oauth",
          allKeys: ["oauth"],
          baseUrl: (def.envBaseUrl ? (env[def.envBaseUrl] ?? "").trim() : "") || def.baseUrl,
        });
        continue;
      }
      // Keyless providers (authType "none") are ALWAYS connected: the
      // upstream answers with no credential at all. An env key, when the
      // user sets one, is attached opportunistically (higher anonymous rate
      // limit) but is never required — and the executor sends no
      // Authorization header while it is absent. The pool must be
      // non-empty for the router's rotation loop, so the anonymous slot is
      // represented by a single empty-string key.
      if (def.authType === "none") {
        if (def.disabled) continue;
        const keys = collectKeys(def.envKey, env);
        const { envKey: _ek, envBaseUrl: _eb, ...rest } = def;
        out.push({
          ...rest,
          apiKey: keys[0] ?? "",
          allKeys: keys.length > 0 ? keys : [""],
          baseUrl: (def.envBaseUrl ? (env[def.envBaseUrl] ?? "").trim() : "") || def.baseUrl,
        });
        continue;
      }
      const keys = collectKeys(def.envKey, env);
      // muse-code may be connected by device login alone (session file,
      // no API key): the executor resolves/remints credentials at call time.
      if (keys.length === 0 && def.id === "muse-code" && hasProviderSession("muse-code", env)) {
        const { envKey: _ek2, envBaseUrl: _eb2, ...rest2 } = def;
        out.push({
          ...rest2,
          apiKey: "",
          allKeys: ["session"],
          baseUrl: def.baseUrl,
        });
        continue;
      }
      if (keys.length === 0 && !def.noAuth) continue;
      const { envKey: _ek, envBaseUrl: _eb, ...rest } = def;
      out.push({
        ...rest,
        apiKey: keys[0] ?? "",
        // keyless slots: noAuth providers without a configured key also get
        // the single "" pool slot so the router's rotation loop dispatches
        // them instead of throwing "no healthy account keys"
        allKeys: keys.length > 0 ? keys : (def.noAuth ? [""] : []),
        baseUrl: (def.envBaseUrl ? (env[def.envBaseUrl] ?? "").trim() : "") || def.baseUrl,
      });
    }
    return out;
  }

  get(id: string): ProviderDef | undefined {
    return this.defs.find((d) => d.id === id);
  }

  all(): ProviderDef[] {
    return [...this.defs];
  }
}

export const registry = new ProviderRegistry();
