/**
 * BlackboxWebDriver — Blackbox AI (app.blackbox.ai) cookie web chat.
 *
 * Ported from OmniRoute (MIT License,
 * https://github.com/diegosouzapw/OmniRoute, release v3.8.53).
 * Source paths in OmniRoute:
 *   open-sse/executors/blackbox-web.ts       (the WEB protocol — this driver)
 *   open-sse/services/tokenExtractionConfig.ts
 *     (blackbox-web: cookie `connect.sid` on .blackbox.ai + localStorage
 *      `token`; the executor's own session-cookie name is
 *      `next-auth.session-token` — this driver sends the whole imported jar
 *      header for app.blackbox.ai, so either cookie works)
 * NOTE: open-sse/config/providers/registry/blackbox/index.ts is Blackbox's
 * paid API (api.blackbox.ai, apikey auth) — deliberately NOT used here.
 *
 * Protocol (as coded upstream):
 *   bootstrap:
 *     GET  https://app.blackbox.ai/api/auth/session       -> session JSON
 *          (user.email becomes `teamAccount`)
 *     POST https://app.blackbox.ai/api/check-subscription { email }
 *          -> mapped into a `subscriptionCache` object embedded in chat
 *   chat:
 *     POST https://app.blackbox.ai/api/chat  (JSON; large fixed-shape body —
 *     see buildBody) with fields incl. messages [{id, role, content}],
 *     id = 7-char chat id, userSelectedModel, userSelectedAgent "VscodeAgent",
 *     validated token, session, isPremium, teamAccount, subscriptionCache.
 *   Response is PLAIN TEXT (not JSON/SSE); upstream reads the whole body.
 *   Blackbox also reports some failures in-band with HTTP 200 (upgrade /
 *   login / rate-limit wording) — those are detected and re-thrown.
 *   System messages are folded into the first user message as a
 *   "System instructions:" prefix (upstream parseOpenAIMessages).
 *
 * ⚠️ NEEDS LIVE VERIFICATION: mock-tested only. In particular the
 * `validated` field: upstream (issue #2252) found /api/chat returns 403
 * unless it matches the frontend `tk` token; OmniRoute uses the
 * BLACKBOX_WEB_VALIDATED_TOKEN env var when set and a random UUID otherwise
 * (which only works while Blackbox doesn't enforce a specific value). This
 * driver mirrors that exactly.
 */
import type { CookieJar } from "../../cookieJar.js";
import {
  BROWSER_UA,
  WebChatError,
  harvestCookies,
  requireCookieHeader,
  singleChunkStream,
  type ChatMessage,
  type WebChatDriver,
} from "./types.js";

const APP_BASE = "https://app.blackbox.ai";
const CHAT_API = `${APP_BASE}/api/chat`;
const SESSION_API = `${APP_BASE}/api/auth/session`;
const SUBSCRIPTION_API = `${APP_BASE}/api/check-subscription`;

interface BlackboxMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** Port of upstream parseOpenAIMessages (tool handling omitted). */
function parseMessages(
  messages: ChatMessage[],
  chatId: string,
): BlackboxMessage[] {
  const systemParts: string[] = [];
  const parsed: BlackboxMessage[] = [];
  for (const message of messages) {
    const content = (message.content ?? "").trim();
    if (!content) continue;
    if (message.role === "system") {
      systemParts.push(content);
      continue;
    }
    parsed.push({
      id: message.role === "user" ? chatId : crypto.randomUUID(),
      role: message.role,
      content,
    });
  }
  if (systemParts.length > 0) {
    const prefix = `System instructions:\n${systemParts.join("\n\n")}`;
    const firstUserIndex = parsed.findIndex((m) => m.role === "user");
    if (firstUserIndex >= 0) {
      const first = parsed[firstUserIndex]!;
      parsed[firstUserIndex] = {
        ...first,
        content: `${prefix}\n\n${first.content}`,
      };
    } else {
      parsed.unshift({ id: chatId, role: "user", content: prefix });
    }
  }
  return parsed;
}

/** Upstream resolveBlackboxValidatedToken: env override, else random UUID. */
function resolveValidatedToken(): string {
  const explicit = (process.env.BLACKBOX_WEB_VALIDATED_TOKEN || "").trim();
  if (explicit) return explicit;
  return crypto.randomUUID();
}

function isValidatedTokenError(responseText: string): boolean {
  const lower = (responseText || "").toLowerCase();
  return (
    lower.includes("invalid validated token") ||
    lower.includes("invalid validated") ||
    lower.includes("validation token") ||
    lower.includes("invalid token")
  );
}

export class BlackboxWebDriver implements WebChatDriver {
  readonly id = "blackbox";
  readonly cookieDomains = [".blackbox.ai", "app.blackbox.ai"];
  readonly cookieHint =
    "log in at app.blackbox.ai and import its cookies (needs the connect.sid / next-auth.session-token session cookie)";

  private bootstrapped = false;
  private sessionData: Record<string, unknown> | null = null;
  private subscriptionCache: Record<string, unknown> | null = null;
  private teamAccount = "";

  constructor(
    private jar: CookieJar,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private cookieHeader(): string {
    return requireCookieHeader(this.jar, CHAT_API, this.id, this.cookieHint);
  }

  /**
   * Fetch session + subscription (embedded in every chat body upstream).
   * Idempotent. A failed session fetch is non-fatal upstream — the chat
   * request still goes out with session: null — so only a missing cookie
   * header throws here.
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const cookie = this.cookieHeader();
    this.bootstrapped = true;
    const headers = {
      accept: "application/json",
      cookie,
      "user-agent": BROWSER_UA,
      origin: APP_BASE,
    };
    try {
      const sessionRes = await this.fetchFn(SESSION_API, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      harvestCookies(this.jar, sessionRes, SESSION_API);
      this.sessionData = sessionRes.ok
        ? ((await sessionRes.json()) as Record<string, unknown>)
        : null;
      const email = (
        this.sessionData?.user as Record<string, unknown> | undefined
      )?.email as string | undefined;
      this.teamAccount = email || "";

      if (email) {
        const subRes = await this.fetchFn(SUBSCRIPTION_API, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ email }),
          signal: AbortSignal.timeout(10_000),
        });
        harvestCookies(this.jar, subRes, SUBSCRIPTION_API);
        const rawSub = subRes.ok
          ? ((await subRes.json()) as Record<string, unknown>)
          : null;
        if (rawSub) {
          this.subscriptionCache = {
            status: rawSub.hasActiveSubscription ? "PREMIUM" : "FREE",
            customerId: rawSub.customerId ?? null,
            expiryTimestamp: rawSub.expiryTimestamp ?? null,
            lastChecked: Date.now(),
            isTrialSubscription: rawSub.isTrialSubscription ?? false,
            hasPaymentVerificationFailure: false,
            verificationFailureTimestamp: null,
            requiresAuthentication: false,
            isTeam: rawSub.isTeam ?? false,
            numSeats: rawSub.numSeats ?? 1,
            provider: rawSub.provider ?? null,
            previouslySubscribed: rawSub.previouslySubscribed ?? false,
            activeInsuffientCredits: rawSub.activeInsuffientCredits ?? false,
          };
        }
      }
    } catch {
      // Non-fatal (upstream behavior): chat proceeds with what we have.
    }
  }

  /** The /api/chat body, field-for-field as upstream builds it. */
  private buildBody(model: string, messages: ChatMessage[], chatId: string) {
    return {
      messages: parseMessages(messages, chatId),
      id: chatId,
      previewToken: null,
      userId: null,
      codeModelMode: true,
      trendingAgentMode: {},
      isMicMode: false,
      userSystemPrompt: null,
      maxTokens: 1024,
      playgroundTopP: null,
      playgroundTemperature: null,
      isChromeExt: false,
      githubToken: "",
      clickedAnswer2: false,
      clickedAnswer3: false,
      clickedForceWebSearch: false,
      visitFromDelta: false,
      isMemoryEnabled: false,
      mobileClient: false,
      userSelectedModel: model || null,
      userSelectedAgent: "VscodeAgent",
      validated: resolveValidatedToken(),
      imageGenerationMode: false,
      imageGenMode: "autoMode",
      webSearchModePrompt: false,
      deepSearchMode: false,
      promptSelection: "",
      domains: null,
      vscodeClient: false,
      codeInterpreterMode: false,
      customProfile: {
        name: "",
        occupation: "",
        traits: [] as string[],
        additionalInfo: "",
        enableNewChats: false,
      },
      webSearchModeOption: { autoMode: true, webMode: false, offlineMode: false },
      session: this.sessionData,
      isPremium: this.subscriptionCache
        ? this.subscriptionCache.status === "PREMIUM"
        : true,
      teamAccount: this.teamAccount,
      subscriptionCache: this.subscriptionCache,
      beastMode: false,
      reasoningMode: false,
      designerMode: false,
      workspaceId: "",
      asyncMode: false,
      integrations: {},
      isTaskPersistent: false,
      selectedElement: null,
    };
  }

  async chat(model: string, messages: ChatMessage[]): Promise<string> {
    await this.bootstrap();
    const cookie = this.cookieHeader();
    if (parseMessages(messages, "x").length === 0) {
      throw new WebChatError(this.id, "empty query after processing messages");
    }
    const chatId = crypto.randomUUID().slice(0, 7);
    const body = this.buildBody(model, messages, chatId);

    const res = await this.fetchFn(CHAT_API, {
      method: "POST",
      headers: {
        accept: "text/plain, */*",
        "content-type": "application/json",
        cookie,
        origin: APP_BASE,
        referer: `${APP_BASE}/chat/${chatId}`,
        "user-agent": BROWSER_UA,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    harvestCookies(this.jar, res, CHAT_API);
    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      if (res.status === 403 && isValidatedTokenError(errorBody)) {
        throw new WebChatError(
          this.id,
          "Blackbox rejected the request with an invalid `validated` token. If you have a valid frontend token (the `tk` value from app.blackbox.ai's Next.js bundle), set BLACKBOX_WEB_VALIDATED_TOKEN in your environment and restart.",
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new WebChatError(
          this.id,
          `Blackbox auth failed (HTTP ${res.status}) — app.blackbox.ai session cookie may be missing or expired`,
        );
      }
      if (res.status === 429) {
        throw new WebChatError(this.id, "Blackbox rate limited the session. Wait a moment and retry.");
      }
      throw new WebChatError(
        this.id,
        `Blackbox returned HTTP ${res.status}: ${errorBody.slice(0, 200)}`,
      );
    }
    if (!res.body) throw new WebChatError(this.id, "Blackbox returned an empty response body");

    const responseText = (await res.text()).trim();

    // In-band errors with HTTP 200 (upstream detection).
    const isSubscriptionError =
      /not upgraded|upgrade to a premium plan|upgrade.required/i.test(responseText) ||
      responseText.toLowerCase().includes("please upgrade");
    const isAuthError =
      /please login|login required|authentication required/i.test(responseText) &&
      !isSubscriptionError;
    const isRateLimit =
      /rate limit|too many requests/i.test(responseText) && !isSubscriptionError;
    if (isSubscriptionError) {
      throw new WebChatError(
        this.id,
        "Blackbox reports your account lacks a premium subscription. If you have a paid plan, re-import your session cookie from app.blackbox.ai.",
      );
    }
    if (isAuthError) {
      throw new WebChatError(
        this.id,
        "Blackbox session is not authenticated — re-import the session cookie from app.blackbox.ai",
      );
    }
    if (isRateLimit) {
      throw new WebChatError(this.id, "Blackbox rate limited the session. Wait a moment and retry.");
    }
    return responseText;
  }

  async *chatStream(
    model: string,
    messages: ChatMessage[],
  ): AsyncGenerator<string> {
    // /api/chat replies as one plain-text body — single chunk (upstream behavior).
    yield* singleChunkStream(await this.chat(model, messages));
  }
}
