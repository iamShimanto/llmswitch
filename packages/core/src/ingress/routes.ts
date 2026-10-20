import express, { type Request, type Response, type Express } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { chatToResponses, responsesToChat } from "./responses.js";
import { fetchPageText, mapSiteLinks, webSearch } from "../search/index.js";
import { RoutingEventLog } from "../router/events.js";
import { antigravityAccountQuotas } from "../quota/antigravityQuota.js";
import type { Alerter } from "../alerts/index.js";
import { costUsd } from "../billing/prices.js";
import type { PromptCache } from "../cache/index.js";
import { compressText, isCompressionMode } from "../compression/index.js";
import type { Inspector } from "../inspect/index.js";
import { replayEntry } from "../inspect/index.js";
import { truncateMessages } from "../inspect/index.js";
import { redactEnabled, redactPii } from "../privacy/redact.js";
import { randomUUID } from "node:crypto";
import { fanout } from "../playground/index.js";
import {
  mintMuseApiKey,
  pollMuseDeviceToken,
  readMuseCodeSession,
  requestMuseDeviceCode,
  saveMuseCodeSession,
} from "../oauth/museCodeDevice.js";
import { SkillRegistry } from "../skills/index.js";
import { runCombo, validateCombo, type Combo } from "../combos/index.js";
import { anthropicHeaders, fromAnthropicRequest, toAnthropicResponse } from "../translator/anthropic.js";
import { WEBCHAT_PROVIDER_IDS } from "../executor/webchat.js";
import type { AppConfig } from "../config.js";
import type { ResolvedProvider } from "../providers/types.js";
import { createRouter, type Router } from "../router/index.js";
import { isStrategyName, type StrategyName } from "../router/strategies.js";
import type { Store } from "../store/db.js";
import { registerMitmRoutes } from "../mitm/routes.js";
import { registerAntigravityOAuthRoutes } from "../oauth/antigravity.js";
import { CLAUDE_OAUTH_FLOW, CODEX_OAUTH_FLOW, registerProviderOAuthRoutes } from "../oauth/providerOAuth.js";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ChatBody = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().nullable(),
      }),
    )
    .min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional(),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.unknown().optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z.unknown().optional(),
});

export interface RouteDeps {
  config: AppConfig;
  providers: ResolvedProvider[];
  store: Store;
  router: Router;
  cache: PromptCache;
  alerter: Alerter;
  inspector: Inspector;
  routingLog: RoutingEventLog;
  /** Outbound fetch (Google OAuth etc.). Defaults to global fetch; tests inject a mock. */
  fetchFn?: typeof fetch;
  /** Dashboard login sessions — used to gate the /proxy login window. */
  dashboardSessions?: { valid: (token: string | undefined | null) => boolean };
  /** Re-resolve connected providers after credential changes (OAuth connect, key add…). */
  refreshProviders?: () => void;
  /** Full provider registry (catalog pages). */
  registry?: import("../providers/registry.js").ProviderRegistry;
}

export function registerRoutes(app: Express, deps: RouteDeps): void {
  const { config, providers, store, router, cache, alerter, inspector, routingLog } = deps;

  // ---- Runtime settings overrides (dashboard-editable; env vars are the defaults) ----
  function effStrategy(): StrategyName {
    const o = store.getSetting("strategy");
    return o && isStrategyName(o) ? o : config.strategy;
  }
  function effPiiRedact(): boolean {
    const o = store.getSetting("pii_redact");
    if (o === "0") return false;
    if (o === "1") return true;
    return redactEnabled();
  }
  function effBudgetAction(): string {
    return (store.getSetting("budget_action") ?? process.env.BUDGET_ACTION ?? "warn").toLowerCase();
  }
  function effCompressionDefault(): string | undefined {
    const o = store.getSetting("compression_default");
    return o && isCompressionMode(o) ? o : undefined;
  }

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok", version: "0.1.0", providers: providers.map((p) => p.id) });
  });

  // OpenAI-compatible model list
  app.get("/v1/models", (_req: Request, res: Response) => {
    const data = [
      { id: "auto", object: "model", owned_by: "llmswitch" },
      ...providers.flatMap((p) =>
        p.models.map((m) => ({ id: `${p.id}:${m}`, object: "model", owned_by: p.id })),
      ),
    ];
    res.json({ object: "list", data });
  });

  // OpenAI-compatible chat completions
  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: "bad_request" } });
      return;
    }
    let body = parsed.data;

    let strategy: StrategyName = effStrategy();
    const h = req.header("x-llmswitch-strategy");
    if (isStrategyName(h)) strategy = h;
    const sessionId = req.header("x-llmswitch-session") || undefined;
    const bypassCache = req.header("x-llmswitch-cache") === "off";
    const compressHeader = req.header("x-llmswitch-compress") ?? effCompressionDefault();

    // ---- budget enforcement (per key, calendar month) ----
    if (req.apiKey?.budgetUsd != null) {
      const spent = store.monthSpend(req.apiKey.id);
      if (spent >= req.apiKey.budgetUsd) {
        const action = effBudgetAction();
        if (action === "block") {
          res.status(402).json({
            error: {
              message: `monthly budget $${req.apiKey.budgetUsd} exceeded (spent $${spent.toFixed(4)})`,
              type: "budget_exceeded",
            },
          });
          return;
        }
        res.setHeader("x-llmswitch-budget-warning", `spent $${spent.toFixed(4)} of $${req.apiKey.budgetUsd}`);
      }
    }
    // ---- global monthly budget cap (dashboard Settings) ----
    const gcap = parseFloat(store.getSetting("global_budget_usd") ?? "");
    if (Number.isFinite(gcap) && gcap > 0) {
      const gspent = store.totalMonthSpend();
      if (gspent >= gcap) {
        const gaction = effBudgetAction();
        if (gaction === "block") {
          res.status(402).json({
            error: {
              message: `global monthly budget $${gcap} exceeded (spent $${gspent.toFixed(4)})`,
              type: "budget_exceeded",
            },
          });
          return;
        }
        res.setHeader("x-llmswitch-global-budget-warning", `spent $${gspent.toFixed(4)} of $${gcap}`);
      }
    }
    if (isCompressionMode(compressHeader)) {
      body = {
        ...body,
        messages: body.messages.map((m) =>
          m.role === "user" && m.content
            ? { ...m, content: compressText(m.content, compressHeader).text }
            : m,
        ),
      };
    }

    try {
      const onEvent = (e: { type: string; providerId?: string; kind?: string; consecutiveFailures?: number }) => {
        if (e.type === "provider_failed" || e.type === "provider_recovered") {
          routingLog.record({
            type: e.type,
            providerId: e.providerId,
            strategy,
            kind: e.kind,
            consecutiveFailures: e.consecutiveFailures,
          });
        }
        if (e.type === "provider_failed" && (e.consecutiveFailures ?? 0) >= 3) {
          void alerter.send(
            {
              type: "provider_down",
              severity: "critical",
              message: `Provider ${e.providerId} failing (${e.consecutiveFailures}x): ${e.kind}`,
              data: { providerId: e.providerId, kind: e.kind },
            },
            `down:${e.providerId}`,
          );
        }
      };
      const result = await router.route(body, { strategy, sessionId, bypassCache, onEvent });
      routingLog.record({
        type: "routed",
        providerId: result.providerId,
        strategy,
        model: result.model,
        latencyMs: result.latencyMs,
        cached: result.cached === true,
      });

      if (result.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let usage = { prompt_tokens: 0, completion_tokens: 0 };
        for await (const chunk of result.stream) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        store.logUsage({
          keyId: req.apiKey?.id ?? null,
          provider: result.providerId,
          accountId: result.accountId ?? null,
          model: result.model,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          latencyMs: result.latencyMs,
          status: "ok",
          costUsd: costUsd(result.providerId, result.model, usage.prompt_tokens, usage.completion_tokens),
        });
        inspector.record({
          keyId: req.apiKey?.id ?? null,
          provider: result.providerId,
          accountId: result.accountId ?? null,
          model: result.model,
          strategy,
          status: "ok",
          latencyMs: result.latencyMs,
          cached: result.cached === true,
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          costUsd: costUsd(result.providerId, result.model, usage.prompt_tokens, usage.completion_tokens),
          request: truncateMessages(body.messages, effPiiRedact() ? (t) => redactPii(t).text : undefined),
          responsePreview: "[streamed]",
          fullBody: body,
        });
        return;
      }

      const r = result.response!;
      const cost = costUsd(result.providerId, result.model, r.usage.prompt_tokens, r.usage.completion_tokens);
      store.logUsage({
        keyId: req.apiKey?.id ?? null,
        provider: result.providerId,
        accountId: result.accountId ?? null,
        model: result.model,
        promptTokens: r.usage.prompt_tokens,
        completionTokens: r.usage.completion_tokens,
        latencyMs: result.latencyMs,
        status: "ok",
        costUsd: cost,
      });
      inspector.record({
        keyId: req.apiKey?.id ?? null,
        provider: result.providerId,
        accountId: result.accountId ?? null,
        model: result.model,
        strategy,
        status: "ok",
        latencyMs: result.latencyMs,
        cached: result.cached === true,
        promptTokens: r.usage.prompt_tokens,
        completionTokens: r.usage.completion_tokens,
        costUsd: cost,
        request: truncateMessages(body.messages, effPiiRedact() ? (t) => redactPii(t).text : undefined),
        responsePreview: (effPiiRedact() ? redactPii(r.choices[0]?.message.content ?? "").text : (r.choices[0]?.message.content ?? "")).slice(0, 500),
        fullBody: body,
      });
      res.json({ ...r, provider: result.providerId, cached: result.cached === true || undefined });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /no providers connected/.test(message) ? 503 : 502;
      store.logUsage({
        keyId: req.apiKey?.id ?? null,
        provider: "-",
        model: body.model,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        status: "error",
      });
      inspector.record({
        keyId: req.apiKey?.id ?? null,
        provider: "-",
        model: body.model,
        strategy,
        status: "error",
        latencyMs: 0,
        cached: false,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        request: truncateMessages(body.messages, effPiiRedact() ? (t) => redactPii(t).text : undefined),
        responsePreview: (effPiiRedact() ? redactPii(message).text : message).slice(0, 500),
        fullBody: body,
      });
      res.status(status).json({ error: { message, type: "upstream_error" } });
    }
  });

  // ---- Anthropic Messages API (ingress: Claude Code / Anthropic SDK clients) ----
  app.post("/v1/messages", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.model !== "string" || !body.model) {
      res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "model is required" } });
      return;
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: "messages is required" } });
      return;
    }
    const chatBody = fromAnthropicRequest(body);
    const strategy: StrategyName = effStrategy();
    const msgId = `msg_${randomBytes(12).toString("hex")}`;
    try {
      const result = await router.route(chatBody, { strategy });
      if (result.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const write = (type: string, data: unknown) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        write("message_start", {
          type: "message_start",
          message: {
            id: msgId, type: "message", role: "assistant", model: result.model,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        write("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        let outChunks = 0;
        for await (const chunk of result.stream) {
          const delta = (chunk as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? "";
          if (delta) {
            outChunks++;
            write("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } });
          }
        }
        write("content_block_stop", { type: "content_block_stop", index: 0 });
        write("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outChunks } });
        write("message_stop", { type: "message_stop" });
        res.end();
        store.logUsage({
          keyId: req.apiKey?.id ?? null, provider: result.providerId, model: result.model,
          accountId: result.accountId ?? null,
          promptTokens: 0, completionTokens: outChunks, latencyMs: result.latencyMs, status: "ok", costUsd: 0,
        });
        return;
      }
      const r = result.response!;
      const cost = costUsd(result.providerId, result.model, r.usage.prompt_tokens, r.usage.completion_tokens);
      store.logUsage({
        keyId: req.apiKey?.id ?? null, provider: result.providerId, model: result.model,
        accountId: result.accountId ?? null,
        promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens,
        latencyMs: result.latencyMs, status: "ok", costUsd: cost,
      });
      res.json(toAnthropicResponse(r, body.model));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /no providers connected/.test(message) ? 503 : 502;
      store.logUsage({
        keyId: req.apiKey?.id ?? null, provider: "-", model: String(body.model),
        promptTokens: 0, completionTokens: 0, latencyMs: 0, status: "error",
      });
      res.status(status).json({ type: "error", error: { type: "api_error", message } });
    }
  });

  // ---- OpenAI Responses API ----
  app.post("/v1/responses", async (req: Request, res: Response) => {
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    if (!model) {
      res.status(400).json({ error: { message: "model is required", type: "bad_request" } });
      return;
    }
    const chatBody = responsesToChat({
      model,
      input: req.body?.input,
      instructions: req.body?.instructions,
      max_output_tokens: req.body?.max_output_tokens,
      temperature: req.body?.temperature,
      stream: req.body?.stream,
    });
    const strategy: StrategyName = effStrategy();
    try {
      const result = await router.route(chatBody, { strategy });
      if (result.stream) {
        const respId = `resp_${randomBytes(12).toString("hex")}`;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const write = (type: string, data: unknown) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        write("response.created", { type: "response.created", response: { id: respId, object: "response", model } });
        for await (const chunk of result.stream) {
          const delta = (chunk as any).choices?.[0]?.delta?.content ?? "";
          if (delta) {
            write("response.output_text.delta", {
              type: "response.output_text.delta",
              item_id: `msg_${respId}`,
              delta,
            });
          }
        }
        write("response.completed", {
          type: "response.completed",
          response: { id: respId, object: "response", model, status: "completed" },
        });
        res.end();
        return;
      }
      const out = chatToResponses(result.response!, model);
      store.logUsage({
        keyId: req.apiKey?.id ?? null,
        provider: result.providerId,
        accountId: result.accountId ?? null,
        model: result.model,
        promptTokens: out.usage.input_tokens,
        completionTokens: out.usage.output_tokens,
        latencyMs: result.latencyMs,
        status: "ok",
        costUsd: costUsd(result.providerId, result.model, out.usage.input_tokens, out.usage.output_tokens),
      });
      res.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /no providers connected/.test(message) ? 503 : 502;
      res.status(status).json({ error: { message, type: "upstream_error" } });
    }
  });

  // ---- Legacy completions + moderations ----
  app.post("/v1/completions", async (req: Request, res: Response) => {
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    const prompt = req.body?.prompt;
    if (!model || prompt == null) {
      res.status(400).json({ error: { message: "model and prompt are required", type: "bad_request" } });
      return;
    }
    const promptText = Array.isArray(prompt) ? prompt.join("") : String(prompt);
    try {
      const result = await router.route(
        {
          model,
          messages: [{ role: "user", content: promptText }],
          max_tokens: req.body?.max_tokens,
          temperature: req.body?.temperature,
        },
        { strategy: effStrategy() },
      );
      if (result.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for await (const chunk of result.stream) {
          const c = chunk as any;
          const text = c.choices?.[0]?.delta?.content ?? "";
          res.write(
            `data: ${JSON.stringify({ id: c.id, object: "text_completion", created: c.created, model: result.model, choices: [{ text, index: 0, finish_reason: c.choices?.[0]?.finish_reason ?? null }] })}\n\n`,
          );
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const r = result.response!;
      res.json({
        id: r.id,
        object: "text_completion",
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: r.choices.map((ch) => ({
          text: ch.message.content ?? "",
          index: ch.index,
          finish_reason: ch.finish_reason,
        })),
        usage: r.usage,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/no providers connected/.test(message) ? 503 : 502).json({ error: { message, type: "upstream_error" } });
    }
  });

  app.post("/v1/moderations", async (req: Request, res: Response) => {
    if (!req.body?.input) {
      res.status(400).json({ error: { message: "input is required", type: "bad_request" } });
      return;
    }
    await passthroughJson(req, res, "/moderations", {
      model: req.body.model ?? "omni-moderation-latest",
      input: req.body.input,
    });
  });

  // ---- Media APIs (embeddings / images / audio): direct provider passthrough ----
  /**
   * Media/passthrough endpoints need a REAL OpenAI-wire API provider. Chat-only
   * web transports (DuckDuckGo AI Chat + the cookie web-session providers) run
   * custom executors — a raw HTTP passthrough to their base URL returns the
   * site's HTML homepage, so they must never be selected here.
   */
  function isMediaCapable(p: ResolvedProvider): boolean {
    return (
      p.wireFormat === "openai" &&
      p.authType !== "cookie" &&
      p.id !== "duckduckgo-web" &&
      !WEBCHAT_PROVIDER_IDS.has(p.id)
    );
  }

  function resolveMediaProvider(modelStr: string): ResolvedProvider | null {
    if (!modelStr) return null;
    const capable = providers.filter(isMediaCapable);
    if (modelStr === "auto") return capable[0] ?? null;
    const colon = modelStr.indexOf(":");
    if (colon > 0) {
      const p = providers.find((x) => x.id === modelStr.slice(0, colon));
      if (p) return p;
    }
    return (
      capable.find((x) => x.models.includes(modelStr)) ??
      capable[0] ??
      null
    );
  }

  async function passthroughJson(
    req: Request,
    res: Response,
    upstreamPath: string,
    upstreamBody: unknown,
  ): Promise<void> {
    const modelStr = typeof req.body?.model === "string" ? req.body.model : "auto";
    const p = resolveMediaProvider(modelStr);
    if (!p) {
      res.status(503).json({ error: { message: "no providers connected", type: "upstream_error" } });
      return;
    }
    if (p.wireFormat !== "openai") {
      res.status(400).json({
        error: { message: `provider ${p.id} does not support this media API (openai wire required)`, type: "bad_request" },
      });
      return;
    }
    try {
      const upstream = await fetch(`${p.baseUrl}${upstreamPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await upstream.text();
      const uct = upstream.headers.get("content-type") ?? "";
      if (uct.includes("text/html")) {
        res.status(502).json({
          error: { message: `provider ${p.id} does not support this endpoint (returned an HTML page)`, type: "upstream_error" },
        });
        return;
      }
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type") ?? "application/json";
      res.setHeader("content-type", ct);
      res.send(text);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } });
    }
  }

  app.post("/v1/embeddings", async (req: Request, res: Response) => {
    if (!req.body?.input || !req.body?.model) {
      res.status(400).json({ error: { message: "model and input are required", type: "bad_request" } });
      return;
    }
    await passthroughJson(req, res, "/embeddings", { model: req.body.model, input: req.body.input });
  });

  app.post("/v1/images/generations", async (req: Request, res: Response) => {
    if (!req.body?.prompt || !req.body?.model) {
      res.status(400).json({ error: { message: "model and prompt are required", type: "bad_request" } });
      return;
    }
    await passthroughJson(req, res, "/images/generations", {
      model: req.body.model,
      prompt: req.body.prompt,
      size: req.body.size,
      n: req.body.n,
    });
  });

  // ---- Files API (passthrough) ----
  function mediaProviderOr503(res: Response): ResolvedProvider | null {
    const p = providers.find(isMediaCapable) ?? null;
    if (!p) {
      res.status(503).json({ error: { message: "no suitable provider connected", type: "upstream_error" } });
      return null;
    }
    return p;
  }

  async function passthroughUpstream(
    req: Request,
    res: Response,
    method: string,
    upstreamPath: string,
    body?: { raw: Buffer; contentType: string } | { json: unknown },
  ): Promise<void> {
    // Files/Batches are OpenAI-style APIs most providers never implement.
    // Try every media-capable candidate (likely supporters first) instead of
    // pinning the first one — a chat-only host's 405 used to surface as a
    // raw page error even when another provider could have served it.
    const supportScore = (p: ResolvedProvider): number =>
      p.baseUrl.includes("api.openai.com") || p.id === "openai" ? 2 : p.baseUrl.includes("azure") ? 1 : 0;
    const candidates = providers
      .filter(isMediaCapable)
      .sort((a, b) => supportScore(b) - supportScore(a));
    if (candidates.length === 0) {
      res.status(503).json({ error: { message: "no suitable provider connected", type: "upstream_error" } });
      return;
    }
    const isListGet =
      method === "GET" && (upstreamPath === "/batches" || upstreamPath === "/files");
    for (const p of candidates) {
      try {
        const headers: Record<string, string> = { authorization: `Bearer ${p.apiKey}` };
        let fetchBody: BodyInit | undefined;
        if (body) {
          if ("raw" in body) {
            headers["content-type"] = body.contentType;
            fetchBody = new Uint8Array(body.raw);
          } else {
            headers["content-type"] = "application/json";
            fetchBody = JSON.stringify(body.json);
          }
        }
        const upstream = await fetch(`${p.baseUrl}${upstreamPath}`, {
          method,
          headers,
          body: fetchBody,
          signal: AbortSignal.timeout(300_000),
        });
        const pct = upstream.headers.get("content-type") ?? "";
        // 404/405/501 or an HTML page = this provider does not implement the
        // endpoint at all — fall through to the next candidate.
        if (
          upstream.status === 404 ||
          upstream.status === 405 ||
          upstream.status === 501 ||
          // Chat-only hosts answer 400 "invalid path" for non-chat APIs
          // (e.g. LLM7) — that is also "not implemented here".
          upstream.status === 400 ||
          pct.includes("text/html") ||
          // A keyless candidate answering 401/403 just gates everything
          // behind auth (e.g. OVH) — it cannot serve this API either.
          // (With a key present, 401 is a real answer and is returned.)
          (!p.apiKey && (upstream.status === 401 || upstream.status === 403))
        ) {
          continue;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        if (upstream.status >= 400 && !pct.includes("json")) {
          res.status(upstream.status).json({
            error: {
              message: `provider ${p.id} returned HTTP ${upstream.status} for ${upstreamPath}`,
              type: "upstream_error",
            },
          });
          return;
        }
        res.status(upstream.status);
        res.setHeader("content-type", pct || "application/json");
        res.send(buf);
        return;
      } catch {
        continue; // network failure on this candidate — try the next
      }
    }
    // No connected provider implements this API.
    if (isListGet) {
      res.json({ object: "list", data: [], supported: false });
      return;
    }
    res.status(501).json({
      error: {
        message:
          "No connected provider supports this API — Files/Batches are OpenAI-style features. " +
          "Connect OpenAI (or another provider that implements them) to use it.",
        type: "not_supported",
      },
    });
  }

  app.post(
    "/v1/files",
    express.raw({ type: "*/*", limit: "100mb" }),
    async (req: Request, res: Response) =>
      passthroughUpstream(req, res, "POST", "/files", {
        raw: req.body as Buffer,
        contentType: req.headers["content-type"] ?? "multipart/form-data",
      }),
  );
  app.get("/v1/files", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "GET", "/files"),
  );
  app.get("/v1/files/:id", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "GET", `/files/${encodeURIComponent(req.params.id)}`),
  );
  app.get("/v1/files/:id/content", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "GET", `/files/${encodeURIComponent(req.params.id)}/content`),
  );
  app.delete("/v1/files/:id", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "DELETE", `/files/${encodeURIComponent(req.params.id)}`),
  );

  // ---- Batches API (passthrough) ----
  app.post("/v1/batches", async (req: Request, res: Response) => {
    if (!req.body?.input_file_id || !req.body?.endpoint) {
      res.status(400).json({ error: { message: "input_file_id and endpoint are required", type: "bad_request" } });
      return;
    }
    await passthroughUpstream(req, res, "POST", "/batches", {
      json: {
        input_file_id: req.body.input_file_id,
        endpoint: req.body.endpoint,
        completion_window: req.body.completion_window ?? "24h",
        metadata: req.body.metadata,
      },
    });
  });
  app.get("/v1/batches", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "GET", "/batches"),
  );
  app.get("/v1/batches/:id", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "GET", `/batches/${encodeURIComponent(req.params.id)}`),
  );
  // SSE progress stream for a batch: polls upstream until a terminal status.
  app.get("/v1/batches/:id/stream", async (req: Request, res: Response) => {
    const p = mediaProviderOr503(res);
    if (!p) return;
    const id = encodeURIComponent(req.params.id);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const terminal = new Set(["completed", "failed", "cancelled", "expired"]);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      res.write("data: [DONE]\n\n");
      res.end();
    };
    const poll = async (): Promise<void> => {
      try {
        const upstream = await fetch(`${p.baseUrl}/batches/${id}`, {
          headers: { authorization: `Bearer ${p.apiKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        const json = (await upstream.json()) as Record<string, unknown>;
        const status = typeof json.status === "string" ? json.status : "unknown";
        res.write(`data: ${JSON.stringify({ id: json.id ?? req.params.id, status, request_counts: json.request_counts ?? null })}\n\n`);
        if (terminal.has(status)) finish();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
        finish();
      }
    };
    const timer = setInterval(() => void poll(), 3000);
    req.on("close", () => finish());
    await poll();
  });
  app.post("/v1/batches/:id/cancel", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "POST", `/batches/${encodeURIComponent(req.params.id)}/cancel`, { json: {} }),
  );
  app.post("/v1/batches/delete-completed", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "POST", "/batches/delete-completed", { json: {} }),
  );

  // ---- Provider plugin manifest (for coding tools: Cline, Cursor, VS Code, …) ----
  // POST so callers can request a tool-specific shape: { format: "cline"|"cursor"|"generic" }.
  // Never includes API keys — the caller supplies their own llmswitch key.
  app.post("/v1/provider-plugin-manifest", (req: Request, res: Response) => {
    const format = req.body?.format === "cline" || req.body?.format === "cursor" ? req.body.format : "generic";
    const list = providers.map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models,
      defaultModel: p.defaultModel,
      wireFormat: p.wireFormat,
    }));
    const base = {
      gateway: "llmswitch",
      format,
      endpoints: {
        chatCompletions: "/v1/chat/completions",
        responses: "/v1/responses",
        models: "/v1/models",
        embeddings: "/v1/embeddings",
      },
      auth: { header: "Authorization", scheme: "Bearer", note: "use your llmswitch API key" },
      providers: list,
    };
    if (format === "cline") {
      res.json({
        ...base,
        cline: {
          apiProvider: "openai-compatible",
          baseUrl: "/v1",
          note: "Set Cline's OpenAI-compatible base URL to this gateway's /v1 and paste your llmswitch key.",
        },
      });
      return;
    }
    if (format === "cursor") {
      res.json({
        ...base,
        cursor: {
          note: "In Cursor Settings → Models → OpenAI API Key: paste your llmswitch key and set OpenAI Base URL to this gateway's /v1.",
          openAIBaseUrl: "/v1",
        },
      });
      return;
    }
    res.json(base);
  });

  // NOTE (route parity): intentionally NOT implemented — low value / provider-specific:
  // Jina /v1/classify + /v1/segment, Vertex /v1/ocr, /v1/music/generations,
  // vscode/* client shims, /v1/relay/chat (404s upstream), /v1/media/:id.

  // ---- Routing explainability ----
  function routingExplain() {
    const quality: Record<string, { calls: number; errors: number; avgLatencyMs: number; errorRate: number }> = {};
    for (const [id, s] of router.stats) {
      quality[id] = {
        calls: s.calls,
        errors: s.errors,
        avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0,
        errorRate: s.calls > 0 ? s.errors / s.calls : 0,
      };
    }
    return { events: routingLog.recent(50), quality };
  }
  app.get("/v1/explain/routing", (_req: Request, res: Response) => {
    res.json(routingExplain());
  });
  // management alias (dashboard uses this; admin-gated when ADMIN_KEY is set)
  app.get("/api/explain/routing", (_req: Request, res: Response) => {
    res.json(routingExplain());
  });

  // ---- Login-window proxy (cookie providers) ----
  // The dashboard opens /proxy/<id>/?s=<dashboard session|admin key>: the
  // provider's own site loads THROUGH the gateway, so when the user logs in
  // there, the site's responses pass through us and we capture the session
  // cookies into the provider's session file — it connects automatically.
  // Best effort: multi-domain auth hosts and anti-bot walls can still block
  // some providers; the paste import below remains the fallback.
  const proxyJars = new Map<string, Map<string, string>>();
  const PROXY_COOKIE = "llmswitch_proxy";

  function proxyGateToken(req: Request): string {
    const fromQuery = typeof req.query.s === "string" ? req.query.s : "";
    if (fromQuery) return fromQuery;
    const cookieHeader = req.headers.cookie ?? "";
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0 && part.slice(0, eq).trim() === PROXY_COOKIE) return part.slice(eq + 1).trim();
    }
    return "";
  }

  function proxyAuthed(req: Request): boolean {
    const tok = proxyGateToken(req);
    if (!tok) return false;
    const admin = (process.env.ADMIN_KEY ?? "").trim();
    if (admin && tok === admin) return true;
    return deps.dashboardSessions?.valid(tok) ?? false;
  }

  function persistProxyJar(def: import("../providers/types.js").ProviderDef): void {
    const jar = proxyJars.get(def.id);
    if (!jar || jar.size === 0) return;
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${def.id}.json`);
    const cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    let domain = "";
    try {
      domain = def.baseUrl ? new URL(def.baseUrl).hostname : "";
    } catch {
      domain = "";
    }
    writeFileSync(
      file,
      JSON.stringify({ kind: "cookies", provider: def.id, cookies, cookieDomain: domain, savedAt: Date.now() }, null, 2),
      { mode: 0o600 },
    );
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    deps.refreshProviders?.();
  }

  const proxyHandler = async (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def || (def.authType ?? "") !== "cookie" || !def.baseUrl) {
      res.status(404).send("unknown cookie provider");
      return;
    }
    if (!proxyAuthed(req)) {
      res.status(401).send("Open this login window from the LLMSwitch dashboard: Providers → this provider → Open login window.");
      return;
    }
    // Arriving with the gate token in the query: store it as a cookie scoped
    // to /proxy (so page assets pass the gate) and continue at a clean URL.
    if (typeof req.query.s === "string" && req.query.s) {
      res.cookie(PROXY_COOKIE, req.query.s, { httpOnly: true, path: "/proxy", sameSite: "lax", maxAge: 3600_000 });
      const clean = req.originalUrl.replace(/([?&])s=[^&]*&?/, "$1").replace(/[?&]$/, "");
      res.redirect(302, clean || `/proxy/${def.id}/`);
      return;
    }
    const fetchFn = deps.fetchFn ?? fetch;
    const origin = new URL(def.baseUrl).origin;
    const rest = req.params[0] ? `/${req.params[0]}` : "/";
    const qIndex = req.originalUrl.indexOf("?");
    const search = qIndex >= 0 ? req.originalUrl.slice(qIndex) : "";
    const target = origin + rest + search;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v !== "string") continue;
      const lk = k.toLowerCase();
      if (["host", "connection", "content-length", "cookie", "accept-encoding"].includes(lk)) continue;
      headers[k] = v;
    }
    headers["accept-encoding"] = "identity";
    const jar = proxyJars.get(def.id);
    if (jar && jar.size > 0) {
      headers.cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    let body: string | undefined;
    if (!["GET", "HEAD"].includes(req.method)) {
      const ct = req.headers["content-type"] ?? "";
      if (typeof req.body === "string") body = req.body;
      else if (req.body && typeof req.body === "object") {
        body = ct.includes("application/json")
          ? JSON.stringify(req.body)
          : new URLSearchParams(req.body as Record<string, string>).toString();
      }
    }
    let up: Awaited<ReturnType<typeof fetch>>;
    try {
      up = await fetchFn(target, { method: req.method, headers, body, redirect: "manual" });
    } catch (err) {
      res.status(502).send(`proxy fetch failed: ${err instanceof Error ? err.message : "unknown"}`);
      return;
    }
    // Capture session cookies
    const getSetCookie = (up.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(up.headers) : [];
    if (setCookies.length > 0) {
      const j = proxyJars.get(def.id) ?? new Map<string, string>();
      proxyJars.set(def.id, j);
      let changed = false;
      for (const sc of setCookies) {
        const pair = sc.split(";")[0] ?? "";
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (j.get(name) !== value) {
          j.set(name, value);
          changed = true;
        }
      }
      if (changed) persistProxyJar(def);
    }
    // Forward response (minus framing/security headers that would break the window)
    for (const [k, v] of up.headers) {
      const lk = k.toLowerCase();
      if (["content-security-policy", "x-frame-options", "set-cookie", "content-length", "transfer-encoding", "content-encoding"].includes(lk)) continue;
      if (lk === "location") {
        let loc = v;
        if (loc.startsWith(origin)) loc = `/proxy/${def.id}` + loc.slice(origin.length);
        else if (loc === "/") loc = `/proxy/${def.id}/`;
        res.setHeader(k, loc);
        continue;
      }
      res.setHeader(k, v);
    }
    res.status(up.status);
    const buf = Buffer.from(await up.arrayBuffer());
    const ct = up.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) {
      let text = buf.toString("utf8");
      text = text.split(origin).join(`/proxy/${def.id}`);
      text = text.replace(/(href|src|action)="\//g, `$1="/proxy/${def.id}/`);
      text = text.replace(/(href|src|action)='\//g, `$1='/proxy/${def.id}/`);
      res.send(text);
    } else {
      res.send(buf);
    }
  };
  app.all("/proxy/:id", proxyHandler);
  app.all("/proxy/:id/*", proxyHandler);

  // ---- Web-session management (metadata only — secrets never leave the server) ----
  function sessionsDir(): string {
    return process.env.LLMSWITCH_SESSIONS_DIR ?? (process.env.DATA_DIR ? join(process.env.DATA_DIR, "sessions") : join(homedir(), ".llmswitch", "sessions"));
  }
  app.get("/api/sessions", (_req: Request, res: Response) => {
    const dir = sessionsDir();
    if (!existsSync(dir)) {
      res.json({ sessions: [] });
      return;
    }
    const sessions = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
          return {
            name: f.slice(0, -5),
            kind: typeof j.kind === "string" ? j.kind : "unknown",
            provider: typeof j.provider === "string" ? j.provider : null,
            cookieDomain: typeof j.cookieDomain === "string" ? j.cookieDomain : null,
            expiresAt: typeof j.expiresAt === "number" ? j.expiresAt : null,
            savedAt: typeof j.savedAt === "number" ? j.savedAt : null,
          };
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);
    res.json({ sessions });
  });
  // Dashboard cookie import for web-session (cookie) providers: the user
  // pastes a Cookie header string from their own logged-in browser; stored
  // as the standard session file the webchat executors read (0600).
  app.post("/api/sessions/import", (req: Request, res: Response) => {
    const def = deps.registry?.get(typeof req.body?.provider === "string" ? req.body.provider : "");
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    if ((def.authType ?? "") !== "cookie") {
      res.status(400).json({ error: { message: `provider ${def.id} is not a cookie provider`, type: "bad_request" } });
      return;
    }
    const cookies = typeof req.body?.cookies === "string" ? req.body.cookies.trim() : "";
    if (!cookies) {
      res.status(400).json({ error: { message: "cookies string is required", type: "bad_request" } });
      return;
    }
    let domain = typeof req.body?.cookieDomain === "string" ? req.body.cookieDomain.trim() : "";
    if (!domain && def.baseUrl) {
      try {
        domain = new URL(def.baseUrl).hostname;
      } catch {
        domain = "";
      }
    }
    const accountLabel = typeof req.body?.accountLabel === "string" ? req.body.accountLabel.trim() : "";
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const acct = accountLabel
      ? store.addAccount({ providerId: def.id, label: accountLabel, kind: "session" })
      : null;
    const file = join(dir, acct ? `${def.id}--${acct.id}.json` : `${def.id}.json`);
    const accessToken =
      typeof req.body?.accessToken === "string" && req.body.accessToken.trim()
        ? req.body.accessToken.trim()
        : undefined;
    writeFileSync(
      file,
      JSON.stringify(
        {
          kind: "cookies",
          provider: def.id,
          cookies,
          cookieDomain: domain,
          ...(accessToken ? { accessToken } : {}),
          savedAt: Date.now(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    store.audit("session.cookie_imported", def.id, acct ? `account "${accountLabel}"` : "dashboard import");
    deps.refreshProviders?.();
    res.json({ ok: true, connected: providers.some((p) => p.id === def.id), ...(acct ? { accountId: acct.id } : {}) });
  });

  app.delete("/api/sessions/:name", (req: Request, res: Response) => {
    const name = String(req.params.name).replace(/[^a-z0-9-_]/gi, "_");
    const p = join(sessionsDir(), `${name}.json`);
    if (!existsSync(p)) {
      res.status(404).json({ error: { message: "session not found", type: "not_found" } });
      return;
    }
    unlinkSync(p);
    res.json({ deleted: true });
  });

  // ---- Batches management proxies (dashboard; uses first openai-wire provider) ----
  app.get("/api/batches", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "GET", "/batches"),
  );
  app.post("/api/batches/:id/cancel", async (req: Request, res: Response) =>
    passthroughUpstream(req, res, "POST", `/batches/${encodeURIComponent(req.params.id)}/cancel`, { json: {} }),
  );

  // ---- Runtime config (dashboard Settings; persisted in SQLite) ----
  const ConfigUpdate = z.object({
    strategy: z.string().optional(),
    account_strategy: z.string().optional(),
    pii_redact: z.boolean().optional(),
    compression_default: z.string().nullable().optional(),
    alert_webhook_url: z.string().nullable().optional(),
    budget_action: z.enum(["warn", "block"]).optional(),
    global_budget_usd: z.number().nullable().optional(),
  });
  function effectiveConfig() {
    const sStrategy = store.getSetting("strategy");
    const sRedact = store.getSetting("pii_redact");
    const sCompress = store.getSetting("compression_default");
    const sAction = store.getSetting("budget_action");
    const sBudget = store.getSetting("global_budget_usd");
    return {
      strategy: { value: sStrategy && isStrategyName(sStrategy) ? sStrategy : config.strategy, source: sStrategy ? "db" : "env" },
      account_strategy: {
        value: (() => { const v = store.getSetting("account_strategy"); return v === "least-used" || v === "priority" || v === "random" ? v : "round-robin"; })(),
        source: store.getSetting("account_strategy") ? "db" : "default",
      },
      pii_redact: {
        value: sRedact === "0" ? false : sRedact === "1" ? true : redactEnabled(),
        source: sRedact ? "db" : "env",
      },
      compression_default: { value: sCompress && isCompressionMode(sCompress) ? sCompress : null, source: sCompress ? "db" : "env" },
      alert_webhook_url: {
        value: store.getSetting("alert_webhook_url") ?? process.env.ALERT_WEBHOOK_URL ?? null,
        source: store.getSetting("alert_webhook_url") ? "db" : "env",
        enabled: alerter.enabled,
      },
      budget_action: {
        value: (sAction ?? process.env.BUDGET_ACTION ?? "warn").toLowerCase(),
        source: sAction ? "db" : "env",
      },
      global_budget_usd: {
        value: sBudget != null && sBudget !== "" ? parseFloat(sBudget) : null,
        source: sBudget ? "db" : "env",
        spentMonthToDate: Math.round(store.totalMonthSpend() * 1e6) / 1e6,
      },
    };
  }
  app.get("/api/config", (_req: Request, res: Response) => {
    res.json(effectiveConfig());
  });
  app.put("/api/config", (req: Request, res: Response) => {
    const parsed = ConfigUpdate.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: "bad_request" } });
      return;
    }
    const b = parsed.data;
    if (b.strategy !== undefined) {
      if (!isStrategyName(b.strategy)) {
        res.status(400).json({ error: { message: `unknown strategy: ${b.strategy}`, type: "bad_request" } });
        return;
      }
      store.setSetting("strategy", b.strategy);
    }
    if (b.account_strategy !== undefined) {
      if (!["round-robin", "least-used", "priority", "random"].includes(b.account_strategy)) {
        res.status(400).json({ error: { message: `unknown account strategy: ${b.account_strategy}`, type: "bad_request" } });
        return;
      }
      store.setSetting("account_strategy", b.account_strategy);
    }
    if (b.pii_redact !== undefined) store.setSetting("pii_redact", b.pii_redact ? "1" : "0");
    if (b.compression_default !== undefined) {
      if (b.compression_default && !isCompressionMode(b.compression_default)) {
        res.status(400).json({ error: { message: `unknown compression mode: ${b.compression_default}`, type: "bad_request" } });
        return;
      }
      store.setSetting("compression_default", b.compression_default ?? "");
    }
    if (b.alert_webhook_url !== undefined) {
      store.setSetting("alert_webhook_url", b.alert_webhook_url ?? "");
      alerter.setWebhookUrl(b.alert_webhook_url ?? undefined);
    }
    if (b.budget_action !== undefined) store.setSetting("budget_action", b.budget_action);
    if (b.global_budget_usd !== undefined) {
      if (b.global_budget_usd != null && !(b.global_budget_usd > 0)) {
        res.status(400).json({ error: { message: "global_budget_usd must be positive", type: "bad_request" } });
        return;
      }
      store.setSetting("global_budget_usd", b.global_budget_usd != null ? String(b.global_budget_usd) : "");
    }
    store.audit("config.update", null, "dashboard settings updated");
    res.json(effectiveConfig());
  });

  // ---- Token counting (heuristic: ~4 chars/token) ----
  function estimateTokens(messages: Array<{ content?: unknown }>): number {
    const text = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
    return Math.max(1, Math.ceil(text.length / 4));
  }
  app.post("/v1/messages/count_tokens", (req: Request, res: Response) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    res.json({ input_tokens: estimateTokens(messages) });
  });
  app.post("/v1/responses/input_tokens", (req: Request, res: Response) => {
    const input = req.body?.input;
    const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
    res.json({ input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
  });

  // ---- Model metadata ----
  app.get("/v1/models/query", (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").toLowerCase();
    const data = providers.flatMap((p) =>
      p.models
        .filter((m) => !q || m.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
        .map((m) => ({ id: `${p.id}:${m}`, object: "model", owned_by: p.id })),
    );
    res.json({ object: "list", data });
  });

  // ---- Quota + key status ----
  async function quotaCheck() {
    const entries = await Promise.all(
      providers.map(async (p) => {
        const s = router.stats.get(p.id);
        const entry: Record<string, unknown> = {
          id: p.id,
          connected: true,
          calls: s?.calls ?? 0,
          errors: s?.errors ?? 0,
          telemetry: router.quotaSnapshot().get(p.id) ?? null,
        };
        // OmniRoute-style live quota: Antigravity reports per-account,
        // per-model remaining quota through retrieveUserQuota.
        if (p.id === "antigravity") {
          try {
            const accts = store
              .listAccounts("antigravity")
              .filter((a) => a.enabled)
              .map((a) => ({ id: a.id, label: a.label }));
            entry.accountQuotas = await antigravityAccountQuotas(process.env, accts);
          } catch {
            entry.accountQuotas = [];
          }
        }
        return entry;
      }),
    );
    return { providers: entries };
  }
  app.get("/v1/quotas/check", async (_req: Request, res: Response) => {
    res.json(await quotaCheck());
  });
  // management alias (dashboard uses this; admin-gated when ADMIN_KEY is set)
  app.get("/api/quotas", async (_req: Request, res: Response) => {
    res.json(await quotaCheck());
  });
  // daily aggregates for the Analytics page
  app.get("/api/logs", (req: Request, res: Response) => {
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    res.json(
      store.queryLogs({
        provider: str(req.query.provider),
        model: str(req.query.model),
        status: str(req.query.status),
        keyId: str(req.query.key),
        q: str(req.query.q),
        limit: parseInt(String(req.query.limit ?? "50"), 10) || 50,
        offset: parseInt(String(req.query.offset ?? "0"), 10) || 0,
      }),
    );
  });

  app.get("/api/analytics/summary", (req: Request, res: Response) => {
    const days = Math.min(3650, Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30));
    const keyId = typeof req.query.key === "string" && req.query.key ? req.query.key : undefined;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const summary = store.analyticsSummary(since, keyId);
    res.json({
      ...summary,
      infra: {
        apiKeys: store.listApiKeys().length,
        providersConnected: providers.length,
        modelsTotal: providers.reduce((n, p) => n + p.models.length, 0),
      },
    });
  });

  app.get("/api/usage/daily", (req: Request, res: Response) => {
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30));
    res.json({ days: store.dailyRequests(days) });
  });
  app.get("/v1/me/status", (req: Request, res: Response) => {
    const k = req.apiKey;
    if (!k) {
      res.status(401).json({ error: { message: "missing bearer token", type: "auth_error" } });
      return;
    }
    res.json({
      id: k.id,
      name: k.name,
      rpmLimit: k.rpmLimit,
      budgetUsd: k.budgetUsd,
      monthSpendUsd: store.monthSpend(k.id),
      workspaceId: k.workspaceId,
    });
  });

  // ---- Extra TTS endpoints ----
  app.post("/v1/text-to-speech/:voiceId", async (req: Request, res: Response) => {
    if (!req.body?.input || !req.body?.model) {
      res.status(400).json({ error: { message: "model and input are required", type: "bad_request" } });
      return;
    }
    const p = mediaProviderOr503(res);
    if (!p) return;
    try {
      const upstream = await fetch(`${p.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: req.body.model, input: req.body.input, voice: req.params.voiceId }),
        signal: AbortSignal.timeout(120_000),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const tct = upstream.headers.get("content-type") ?? "";
      if (tct.includes("text/html")) {
        res.status(502).json({
          error: { message: `provider ${p.id} does not support speech (returned an HTML page)`, type: "upstream_error" },
        });
        return;
      }
      res.status(upstream.status);
      res.setHeader("content-type", tct || "audio/mpeg");
      res.send(buf);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } });
    }
  });
  app.get("/v1/voices", async (_req: Request, res: Response) => {
    const p = providers.find(isMediaCapable);
    if (p) {
      try {
        const upstream = await fetch(`${p.baseUrl}/voices`, {
          headers: { authorization: `Bearer ${p.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        const uct = upstream.headers.get("content-type") ?? "";
        if (upstream.ok && uct.includes("json")) {
          const text = await upstream.text();
          res.status(200).setHeader("content-type", "application/json").send(text);
          return;
        }
      } catch { /* fall through to defaults */ }
    }
    res.json({
      voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((id) => ({ id, name: id })),
    });
  });
  app.post(
    "/v1/speech-to-text",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req: Request, res: Response) => passthroughMultipart(req, res, "/audio/transcriptions"),
  );

  // ---- Multimodal embeddings + image upscale ----
  app.post("/v1/multimodal-embeddings", async (req: Request, res: Response) => {
    if (!req.body?.input || !req.body?.model) {
      res.status(400).json({ error: { message: "model and input are required", type: "bad_request" } });
      return;
    }
    await passthroughJson(req, res, "/multimodal-embeddings", { model: req.body.model, input: req.body.input });
  });
  app.post(
    "/v1/images/upscale",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req: Request, res: Response) => passthroughMultipart(req, res, "/images/upscale"),
  );

  // ---- Web search + fetch (needs SEARCH_API_KEY; fetch has SSRF guard) ----
  async function handleSearch(req: Request, res: Response): Promise<void> {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      res.status(400).json({ error: { message: "query is required", type: "bad_request" } });
      return;
    }
    try {
      const out = await webSearch(query, Number(req.body?.max_results ?? 5) || 5);
      res.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /SEARCH_API_KEY/.test(message) ? 503 : 502;
      res.status(status).json({ error: { message, type: "upstream_error" } });
    }
  }
  app.post("/v1/search", handleSearch);
  app.post("/v1/alpha/search", handleSearch);
  app.post("/v1/web/fetch", async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    if (!url) {
      res.status(400).json({ error: { message: "url is required", type: "bad_request" } });
      return;
    }
    try {
      res.json(await fetchPageText(url));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /blocked|invalid|only http/.test(message) ? 400 : 502;
      res.status(status).json({ error: { message, type: "fetch_error" } });
    }
  });
  app.post("/v1/web/map", async (req: Request, res: Response) => {
    const url = typeof req.body?.url === "string" ? req.body.url : "";
    if (!url) {
      res.status(400).json({ error: { message: "url is required", type: "bad_request" } });
      return;
    }
    try {
      res.json(await mapSiteLinks(url, Number(req.body?.limit ?? 50) || 50));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /blocked|invalid|only http/.test(message) ? 400 : 502;
      res.status(status).json({ error: { message, type: "fetch_error" } });
    }
  });

  app.post("/v1/videos/generations", async (req: Request, res: Response) => {
    if (!req.body?.prompt || !req.body?.model) {
      res.status(400).json({ error: { message: "model and prompt are required", type: "bad_request" } });
      return;
    }
    // video gen is async upstream; the provider's job object is returned as-is
    await passthroughJson(req, res, "/videos/generations", {
      model: req.body.model,
      prompt: req.body.prompt,
      size: req.body.size,
      seconds: req.body.seconds,
    });
  });

  app.post("/v1/rerank", async (req: Request, res: Response) => {
    if (!req.body?.query || !req.body?.documents) {
      res.status(400).json({ error: { message: "query and documents are required", type: "bad_request" } });
      return;
    }
    await passthroughJson(req, res, "/rerank", {
      model: req.body.model ?? "auto",
      query: req.body.query,
      documents: req.body.documents,
      top_n: req.body.top_n,
    });
  });

  app.post("/v1/audio/speech", async (req: Request, res: Response) => {
    if (!req.body?.input || !req.body?.model) {
      res.status(400).json({ error: { message: "model and input are required", type: "bad_request" } });
      return;
    }
    const modelStr = req.body.model;
    const p = resolveMediaProvider(modelStr);
    if (!p) {
      res.status(503).json({ error: { message: "no providers connected", type: "upstream_error" } });
      return;
    }
    if (p.wireFormat !== "openai") {
      res.status(400).json({ error: { message: `provider ${p.id} does not support audio`, type: "bad_request" } });
      return;
    }
    try {
      const upstream = await fetch(`${p.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: req.body.model,
          input: req.body.input,
          voice: req.body.voice ?? "alloy",
          response_format: req.body.response_format,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const tct = upstream.headers.get("content-type") ?? "";
      if (tct.includes("text/html")) {
        res.status(502).json({
          error: { message: `provider ${p.id} does not support speech (returned an HTML page)`, type: "upstream_error" },
        });
        return;
      }
      res.status(upstream.status);
      res.setHeader("content-type", tct || "audio/mpeg");
      res.send(buf);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } });
    }
  });

  // multipart forwarded untouched (global json parser skips non-JSON bodies)
  async function passthroughMultipart(req: Request, res: Response, upstreamPath: string): Promise<void> {
    const p = providers[0] ?? null;
    if (!p || p.wireFormat !== "openai") {
      res.status(503).json({ error: { message: "no suitable provider connected", type: "upstream_error" } });
      return;
    }
    try {
      const upstream = await fetch(`${p.baseUrl}${upstreamPath}`, {
        method: "POST",
        headers: {
          "content-type": req.headers["content-type"] ?? "multipart/form-data",
          authorization: `Bearer ${p.apiKey}`,
        },
        body: new Uint8Array(req.body as Buffer),
        signal: AbortSignal.timeout(300_000),
      });
      const text = await upstream.text();
      res.status(upstream.status).setHeader("content-type", "application/json").send(text);
    } catch (err) {
      res.status(502).json({ error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" } });
    }
  }

  app.post(
    "/v1/audio/transcriptions",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req: Request, res: Response) => passthroughMultipart(req, res, "/audio/transcriptions"),
  );

  app.post(
    "/v1/audio/translations",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req: Request, res: Response) => passthroughMultipart(req, res, "/audio/translations"),
  );

  app.post(
    "/v1/images/edits",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req: Request, res: Response) => passthroughMultipart(req, res, "/images/edits"),
  );

  // ---- Dashboard API (used by the SPA) ----
  app.get("/api/providers", (_req: Request, res: Response) => {
    deps.refreshProviders?.();
    res.json(
      providers.map((p) => {
        const pool = router.pools.get(p.id);
        const ps = pool?.status() ?? { total: 1, healthy: 1 };
        return {
          id: p.id,
          name: p.name,
          wireFormat: p.wireFormat,
          authType: p.authType ?? "api-key",
          models: p.models,
          defaultModel: p.defaultModel,
          keysTotal: ps.total,
          keysHealthy: ps.healthy,
          stats: router.stats.get(p.id) ?? { calls: 0, errors: 0, totalLatencyMs: 0 },
        };
      }),
    );
  });

  // Full provider catalog (Providers page directory): every known provider,
  // connected or not — each gets a detail page with models + connect + test.
  app.get("/api/catalog", (_req: Request, res: Response) => {
    deps.refreshProviders?.();
    if (!deps.registry) {
      res.status(501).json({ error: { message: "catalog unavailable", type: "not_implemented" } });
      return;
    }
    const connectedIds = new Set(providers.map((p) => p.id));
    const liveById = new Map(providers.map((p) => [p.id, p]));
    res.json(
      deps.registry.all().map((d) => ({
        id: d.id,
        name: d.name,
        wireFormat: d.wireFormat,
        authType: d.authType ?? "api-key",
        envKey: d.envKey,
        // Live providers carry discovered/imported models merged in.
        models: liveById.get(d.id)?.models ?? d.models,
        // The resolved provider carries any user default-model override.
        defaultModel: liveById.get(d.id)?.defaultModel ?? d.defaultModel,
        connected: connectedIds.has(d.id),
        disabled: Boolean(d.disabled),
      })),
    );
  });

  // Save a provider API key from the dashboard (stored in the local DB as a
  // provider_key:<ENV> setting; connects immediately, no restart).
  app.post("/api/providers/:id/key", (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    if ((def.authType ?? "api-key") !== "api-key" || !def.envKey) {
      res.status(400).json({
        error: { message: `provider ${def.id} does not use an API key (auth: ${def.authType ?? "api-key"})`, type: "bad_request" },
      });
      return;
    }
    const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    if (!key) {
      res.status(400).json({ error: { message: "key is required", type: "bad_request" } });
      return;
    }
    const accountLabel = typeof req.body?.accountLabel === "string" ? req.body.accountLabel.trim() : "";
    if (accountLabel) {
      // Multi-account: store as a named account instead of THE provider key.
      const acct = store.addAccount({ providerId: def.id, label: accountLabel, kind: "api_key", secret: key });
      store.audit("provider.account_added", def.id, `api key account "${accountLabel}"`);
      deps.refreshProviders?.();
      res.json({ ok: true, connected: providers.some((p) => p.id === def.id), accountId: acct.id });
      return;
    }
    store.setSetting(`provider_key:${def.envKey}`, key);
    store.audit("provider.key_saved", def.id, `env ${def.envKey}`);
    deps.refreshProviders?.();
    res.json({ ok: true, connected: providers.some((p) => p.id === def.id) });
  });

  // Per-provider default model override (used when a request names the
  // provider without a model, and shown as the provider's default).
  app.post("/api/providers/:id/default-model", (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    const resolved = providers.find((x) => x.id === def.id);
    const known = resolved?.models ?? def.models;
    if (!model || !known.includes(model)) {
      res.status(400).json({
        error: { message: `model must be one of this provider's known models`, type: "bad_request" },
      });
      return;
    }
    store.setSetting(`default_model:${def.id}`, model);
    store.audit("provider.default_model", def.id, model);
    deps.refreshProviders?.();
    res.json({ ok: true, defaultModel: providers.find((x) => x.id === def.id)?.defaultModel ?? model });
  });

  app.delete("/api/providers/:id/default-model", (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    store.setSetting(`default_model:${def.id}`, "");
    store.audit("provider.default_model_reset", def.id);
    deps.refreshProviders?.();
    res.json({ ok: true, defaultModel: providers.find((x) => x.id === def.id)?.defaultModel ?? def.defaultModel });
  });

  // Token-paste connect for OAuth providers without a browser flow
  // (copilot, cursor, kiro, trae, zed, clinepass, codebuddy, …). Every OAuth
  // executor reads the same session shape — {accessToken, refreshToken?} in
  // <sessions>/<id>.json — so pasting a token connects it immediately.
  app.post("/api/oauth/:id/token", (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    if ((def.authType ?? "") !== "oauth") {
      res.status(400).json({ error: { message: `provider ${def.id} is not an OAuth provider`, type: "bad_request" } });
      return;
    }
    const accessToken = typeof req.body?.accessToken === "string" ? req.body.accessToken.trim() : "";
    if (!accessToken) {
      res.status(400).json({ error: { message: "accessToken is required", type: "bad_request" } });
      return;
    }
    const session: Record<string, unknown> = { accessToken, savedAt: Date.now(), kind: "oauth-token" };
    if (typeof req.body?.refreshToken === "string" && req.body.refreshToken.trim()) {
      session.refreshToken = req.body.refreshToken.trim();
    }
    if (typeof req.body?.userId === "string" && req.body.userId.trim()) {
      session.userId = req.body.userId.trim();
    }
    const accountLabel = typeof req.body?.accountLabel === "string" ? req.body.accountLabel.trim() : "";
    const acct = accountLabel
      ? store.addAccount({ providerId: def.id, label: accountLabel, kind: "session" })
      : null;
    const dir = sessionsDir();
    mkdirSync(dir, { recursive: true });
    const base = def.id === "github" ? "github-copilot" : def.id;
    const file = join(dir, acct ? `${base}--${acct.id}.json` : `${base}.json`);
    writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
    store.audit("oauth.token_saved", def.id, acct ? `account "${accountLabel}"` : "token paste");
    deps.refreshProviders?.();
    res.json({ ok: true, connected: providers.some((p) => p.id === def.id), ...(acct ? { accountId: acct.id } : {}) });
  });

  // ---- Muse Code device login (RFC 8628 + key minting) ----
  const museDevicePending = new Map<string, { deviceCode: string; expiresAt: number; accountLabel?: string }>();

  app.post("/api/oauth/muse-code/device/start", async (req: Request, res: Response) => {
    try {
      const dc = await requestMuseDeviceCode(fetch);
      const state = randomUUID();
      museDevicePending.set(state, {
        deviceCode: dc.deviceCode,
        expiresAt: Date.now() + dc.expiresIn * 1000,
        accountLabel:
          typeof req.body?.accountLabel === "string" && req.body.accountLabel.trim()
            ? req.body.accountLabel.trim()
            : undefined,
      });
      res.json({
        state,
        userCode: dc.userCode,
        verificationUrl: dc.verificationUriComplete || dc.verificationUri,
        expiresIn: dc.expiresIn,
        interval: dc.interval,
      });
    } catch (err) {
      res.status(502).json({
        error: { message: err instanceof Error ? err.message : String(err), type: "upstream_error" },
      });
    }
  });

  app.post("/api/oauth/muse-code/device/poll", async (req: Request, res: Response) => {
    const state = typeof req.body?.state === "string" ? req.body.state : "";
    const pending = museDevicePending.get(state);
    if (!pending) {
      res.status(404).json({ error: { message: "unknown or expired login attempt — start again", type: "not_found" } });
      return;
    }
    if (Date.now() > pending.expiresAt) {
      museDevicePending.delete(state);
      res.json({ status: "expired" });
      return;
    }
    const r = await pollMuseDeviceToken(fetch, pending.deviceCode);
    if (r.status === "pending") {
      res.json({ status: "pending" });
      return;
    }
    museDevicePending.delete(state);
    if (r.status !== "ok") {
      res.json({ status: "failed", error: r.error });
      return;
    }
    // Best-effort mint: a dca-only session still connects (the executor
    // mints on first use), but minting now surfaces the account + tier.
    let minted;
    try {
      minted = await mintMuseApiKey(fetch, r.dcaToken);
    } catch {
      minted = undefined;
    }
    const acct = pending.accountLabel
      ? store.addAccount({ providerId: "muse-code", label: pending.accountLabel, kind: "session" })
      : null;
    const session = saveMuseCodeSession(process.env, { dcaToken: r.dcaToken, minted }, acct?.id);
    store.audit("oauth.muse_code_connected", "muse-code", session.email ?? "device login");
    deps.refreshProviders?.();
    res.json({
      status: "connected",
      email: session.email,
      tier: session.meta.subsTierName,
      subsActive: session.meta.isSubsActive,
      requirePayment: session.meta.requirePayment,
      ...(acct ? { accountId: acct.id } : {}),
    });
  });

  app.get("/api/oauth/muse-code/status", (_req: Request, res: Response) => {
    const s = readMuseCodeSession(process.env);
    if (!s) {
      res.json({ connected: false });
      return;
    }
    res.json({
      connected: providers.some((p) => p.id === "muse-code"),
      email: s.email,
      tier: s.meta.subsTierName,
      subsActive: s.meta.isSubsActive,
      requirePayment: s.meta.requirePayment,
    });
  });

  app.delete("/api/oauth/muse-code", (_req: Request, res: Response) => {
    const file = join(sessionsDir(), "muse-code.json");
    if (existsSync(file)) unlinkSync(file);
    store.audit("oauth.muse_code_disconnected", "muse-code", "device disconnect");
    deps.refreshProviders?.();
    res.json({ ok: true, connected: providers.some((p) => p.id === "muse-code") });
  });

  app.delete("/api/oauth/:id/token", (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    const base = def.id === "github" ? "github-copilot" : def.id;
    const file = join(sessionsDir(), `${base}.json`);
    if (existsSync(file)) unlinkSync(file);
    store.audit("oauth.token_removed", def.id, "token disconnect");
    deps.refreshProviders?.();
    res.json({ ok: true, connected: providers.some((p) => p.id === def.id) });
  });

  app.delete("/api/providers/:id/key", (req: Request, res: Response) => {
    const def = deps.registry?.get(req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    if (def.envKey) store.deleteSetting(`provider_key:${def.envKey}`);
    store.audit("provider.key_removed", def.id, `env ${def.envKey ?? ""}`);
    deps.refreshProviders?.();
    res.json({ ok: true, connected: providers.some((p) => p.id === def.id) });
  });

  // Per-model live test (Providers page): pins provider:model, tiny prompt,
  // truthful result — a silent fallback to another provider counts as fail.
  app.post("/api/providers/:id/test", async (req: Request, res: Response) => {
    const p = providers.find((x) => x.id === req.params.id);
    if (!p) {
      res.status(404).json({ error: { message: "provider not found", type: "not_found" } });
      return;
    }
    const model =
      typeof req.body?.model === "string" && req.body.model ? req.body.model : p.defaultModel;
    const started = Date.now();
    try {
      const result = await router.route(
        {
          model: `${p.id}:${model}`,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
          max_tokens: 16,
        },
        { strategy: "priority", bypassCache: true, timeoutMs: 45_000 },
      );
      const latencyMs = Date.now() - started;
      if (result.providerId !== p.id) {
        // Dashboard tests must show up in Live/Activity like real traffic.
        inspector.record({
          keyId: null,
          provider: p.id,
          model,
          strategy: "test",
          status: "error",
          latencyMs,
          cached: false,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          request: [{ role: "user", content: "Reply with the single word: ok" }],
          responsePreview: `fell back to ${result.providerId}`,
        });
        store.logUsage({
          keyId: null, provider: p.id, model, promptTokens: 0, completionTokens: 0,
          latencyMs, status: "error", costUsd: 0,
        });
        res.json({
          ok: false,
          model,
          latencyMs,
          error: `provider ${p.id} failed — request fell back to ${result.providerId}`,
        });
        return;
      }
      const text = result.response?.choices?.[0]?.message?.content ?? "";
      inspector.record({
        keyId: null,
        provider: p.id,
        model,
        strategy: "test",
        status: "ok",
        latencyMs,
        cached: false,
        promptTokens: result.response?.usage?.prompt_tokens ?? 0,
        completionTokens: result.response?.usage?.completion_tokens ?? 0,
        costUsd: 0,
        request: [{ role: "user", content: "Reply with the single word: ok" }],
        responsePreview: text.slice(0, 500),
        accountId: result.accountId ?? null,
      });
      store.logUsage({
        keyId: null,
        provider: p.id,
        accountId: result.accountId ?? null,
        model,
        promptTokens: result.response?.usage?.prompt_tokens ?? 0,
        completionTokens: result.response?.usage?.completion_tokens ?? 0,
        latencyMs,
        status: "ok",
        costUsd: costUsd(p.id, model, result.response?.usage?.prompt_tokens ?? 0, result.response?.usage?.completion_tokens ?? 0),
      });
      res.json({ ok: true, model, latencyMs, text: text.slice(0, 120) });
    } catch (err) {
      inspector.record({
        keyId: null,
        provider: p.id,
        model,
        strategy: "test",
        status: "error",
        latencyMs: Date.now() - started,
        cached: false,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        request: [{ role: "user", content: "Reply with the single word: ok" }],
        responsePreview: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
      });
      store.logUsage({
        keyId: null, provider: p.id, model, promptTokens: 0, completionTokens: 0,
        latencyMs: Date.now() - started, status: "error", costUsd: 0,
      });
      res.json({
        ok: false,
        model,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/api/usage", (req: Request, res: Response) => {
    const hours = Number(req.query.hours ?? 24);
    res.json(store.usageSummary(Date.now() - hours * 3600_000));
  });

  app.get("/api/keys", (_req: Request, res: Response) => {
    res.json(store.listApiKeys());
  });

  app.delete("/api/keys/:id", (req: Request, res: Response) => {
    const ok = store.revokeApiKey(req.params.id);
    if (ok) store.audit("key.revoked", req.params.id);
    res.status(ok ? 200 : 404).json({ revoked: ok });
  });

  // ---- Provider accounts (multi-account) ----
  const publicAccount = (a: ReturnType<Store["listAccounts"]>[number]) => ({
    id: a.id,
    providerId: a.providerId,
    label: a.label,
    kind: a.kind,
    enabled: a.enabled,
    createdAt: a.createdAt,
    lastUsedAt: a.lastUsedAt,
    calls: a.calls,
    errors: a.errors,
    lastError: a.lastError,
  });

  app.get("/api/accounts", (req: Request, res: Response) => {
    const provider = typeof req.query.provider === "string" ? req.query.provider : undefined;
    res.json({ accounts: store.listAccounts(provider).map(publicAccount) });
  });

  app.post("/api/accounts/:id", (req: Request, res: Response) => {
    const patch: { label?: string; enabled?: boolean } = {};
    if (typeof req.body?.label === "string" && req.body.label.trim()) patch.label = req.body.label.trim();
    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    const ok = store.updateAccount(req.params.id, patch);
    if (ok) {
      store.audit("provider.account_updated", req.params.id, JSON.stringify(patch));
      deps.refreshProviders?.();
    }
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.delete("/api/accounts/:id", (req: Request, res: Response) => {
    const acct = store.getAccount(req.params.id);
    if (!acct) {
      res.status(404).json({ error: { message: "account not found", type: "not_found" } });
      return;
    }
    if (acct.kind === "session") {
      const base = acct.providerId === "github" ? "github-copilot" : acct.providerId;
      const file = join(sessionsDir(), `${base}--${acct.id}.json`);
      if (existsSync(file)) unlinkSync(file);
    }
    store.deleteAccount(acct.id);
    store.audit("provider.account_deleted", acct.providerId, `account "${acct.label}"`);
    deps.refreshProviders?.();
    res.json({ ok: true });
  });

  // ---- Routing rules (per-model provider chains) ----
  app.get("/api/routing-rules", (_req: Request, res: Response) => {
    res.json({ rules: store.listRoutingRules() });
  });

  app.post("/api/routing-rules", (req: Request, res: Response) => {
    const pattern = typeof req.body?.pattern === "string" ? req.body.pattern.trim() : "";
    const providersIn = Array.isArray(req.body?.providers)
      ? (req.body.providers as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const known = providersIn.filter((id) => deps.registry?.get(id));
    if (!pattern || known.length === 0) {
      res.status(400).json({
        error: { message: "pattern and at least one known provider are required", type: "bad_request" },
      });
      return;
    }
    const strategy = typeof req.body?.strategy === "string" ? req.body.strategy : "";
    const rule = store.addRoutingRule({ pattern, providers: known, strategy });
    store.audit("routing.rule_added", rule.id, `${pattern} -> ${known.join(",")}`);
    res.json({ ok: true, rule });
  });

  app.post("/api/routing-rules/:id", (req: Request, res: Response) => {
    const patch: { pattern?: string; providers?: string[]; strategy?: string; enabled?: boolean } = {};
    if (typeof req.body?.pattern === "string" && req.body.pattern.trim()) patch.pattern = req.body.pattern.trim();
    if (Array.isArray(req.body?.providers)) {
      patch.providers = (req.body.providers as unknown[])
        .filter((x): x is string => typeof x === "string")
        .filter((id) => deps.registry?.get(id));
    }
    if (typeof req.body?.strategy === "string") patch.strategy = req.body.strategy;
    if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
    const ok = store.updateRoutingRule(req.params.id, patch);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.delete("/api/routing-rules/:id", (req: Request, res: Response) => {
    const ok = store.deleteRoutingRule(req.params.id);
    if (ok) store.audit("routing.rule_deleted", req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  // ---- Compression preview ----
  app.post("/api/compression/preview", (req: Request, res: Response) => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const mode = isCompressionMode(req.body?.mode) ? req.body.mode : "stacked";
    if (!text) {
      res.status(400).json({ error: { message: "text is required", type: "bad_request" } });
      return;
    }
    res.json(compressText(text, mode));
  });

  // ---- Prompt cache ----
  app.get("/api/cache/stats", (_req: Request, res: Response) => {
    res.json(cache.stats());
  });

  app.delete("/api/cache", (_req: Request, res: Response) => {
    cache.clear();
    store.audit("cache.cleared");
    res.json({ cleared: true });
  });

  // ---- Audit log ----
  app.get("/api/audit", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    res.json(store.listAudit(limit));
  });

  // ---- Workspaces (teams) ----
  app.get("/api/workspaces", (_req: Request, res: Response) => {
    res.json(store.listWorkspaces());
  });

  app.post("/api/workspaces", (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: { message: "name is required", type: "bad_request" } });
      return;
    }
    const ws = store.createWorkspace(name);
    store.audit("workspace.created", null, `name=${name}`);
    res.json(ws);
  });

  app.get("/api/workspaces/:id/usage", (req: Request, res: Response) => {
    const since = Date.now() - 30 * 24 * 3600 * 1000;
    res.json({
      workspace: req.params.id,
      monthToDateUsd: store.workspaceSpend(req.params.id, since),
    });
  });

  app.put("/api/keys/:id/workspace", (req: Request, res: Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    if (!workspaceId) {
      res.status(400).json({ error: { message: "workspaceId is required", type: "bad_request" } });
      return;
    }
    const ok = store.setKeyWorkspace(req.params.id, workspaceId);
    if (ok) store.audit("key.workspace", req.params.id, `workspace=${workspaceId}`);
    res.status(ok ? 200 : 404).json({ workspaceId: ok ? workspaceId : undefined });
  });

  // ---- Request inspector ----
  app.get("/api/inspector", (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    res.json(inspector.list(limit));
  });

  // Live request monitoring (SSE): snapshot + every new inspector entry and
  // routing event as it happens. The dashboard's Live page consumes this.
  app.get("/api/live", (req: Request, res: Response) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", { entries: inspector.list(50), routing: routingLog.recent(20) });
    const sendStats = () => {
      try {
        send("stats", { ...store.liveStats(), providersConnected: providers.length });
      } catch {
        /* stats are best-effort */
      }
    };
    sendStats();
    const statsTimer = setInterval(sendStats, 5_000);
    const unsubEntry = inspector.subscribe((entry) => send("request", entry));
    const unsubRouting = routingLog.subscribe((event) => send("routing", event));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(statsTimer);
      unsubEntry();
      unsubRouting();
    });
  });

  app.get("/api/inspector/:id", (req: Request, res: Response) => {
    const e = inspector.get(req.params.id);
    if (!e) {
      res.status(404).json({ error: { message: "not found", type: "not_found" } });
      return;
    }
    res.json(e);
  });

  // Re-execute a captured request (admin-gated via /api/* when ADMIN_KEY is set).
  app.post("/api/inspector/:id/replay", async (req: Request, res: Response) => {
    const e = inspector.get(req.params.id);
    if (!e) {
      res.status(404).json({ error: { message: "not found", type: "not_found" } });
      return;
    }
    if (!e.fullBody) {
      res.status(400).json({
        error: { message: "replay unavailable: full request body was not captured", type: "bad_request" },
      });
      return;
    }
    try {
      const strat = isStrategyName(e.strategy) ? e.strategy : undefined;
      const out = await replayEntry(e, (body, opts) =>
        router.route(body, strat ? { ...opts, strategy: strat } : opts),
      );
      res.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: { message, type: "upstream_error" } });
    }
  });

  // ---- Playground (fan-out compare) ----
  const PlaygroundBody = z.object({
    messages: z.array(z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string().nullable(),
    })).min(1),
    providers: z.array(z.string()).min(1),
    max_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
  });

  app.post("/api/playground", async (req: Request, res: Response) => {
    const parsed = PlaygroundBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { message: parsed.error.message, type: "bad_request" } });
      return;
    }
    const { providers: ids, ...rest } = parsed.data;
    const selected = providers.filter((p) => ids.includes(p.id));
    if (selected.length === 0) {
      res.status(400).json({ error: { message: "no matching connected providers", type: "bad_request" } });
      return;
    }
    const results = await fanout(selected, { model: "auto", ...rest }, router);
    // Playground traffic counts like real traffic: inspector (→ Live/Logs)
    // + usage_log (→ Analytics).
    for (const r of results) {
      const promptTokens = r.promptTokens ?? 0;
      const completionTokens = r.completionTokens ?? 0;
      inspector.record({
        keyId: null,
        provider: r.providerId,
        model: r.model,
        strategy: "playground",
        status: r.ok ? "ok" : "error",
        latencyMs: r.latencyMs,
        cached: false,
        promptTokens,
        completionTokens,
        costUsd: r.ok ? costUsd(r.providerId, r.model, promptTokens, completionTokens) : 0,
        request: rest.messages.map((m) => ({ role: m.role, content: m.content ?? "" })),
        responsePreview: r.ok ? (r.text ?? "").slice(0, 500) : (r.error ?? "").slice(0, 500),
      });
      store.logUsage({
        keyId: null,
        provider: r.providerId,
        model: r.model,
        promptTokens,
        completionTokens,
        latencyMs: r.latencyMs,
        status: r.ok ? "ok" : "error",
        costUsd: r.ok ? costUsd(r.providerId, r.model, promptTokens, completionTokens) : 0,
      });
    }
    res.json({ results });
  });

  // ---- Model auto-discovery ----
  app.get("/api/providers/:id/discover", async (req: Request, res: Response) => {
    const p = providers.find((x) => x.id === req.params.id);
    if (!p) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    try {
      let models: string[] = [];
      if (p.wireFormat === "anthropic") {
        const r = await fetch(`${p.baseUrl}/v1/models`, {
          headers: anthropicHeaders(p.apiKey),
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = ((await r.json()) as any).data?.map((m: any) => m.id) ?? [];
      } else if (p.wireFormat === "gemini") {
        const r = await fetch(`${p.baseUrl}/v1beta/models?key=${encodeURIComponent(p.apiKey)}`, {
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = ((await r.json()) as any).models?.map((m: any) => m.name?.replace("models/", "")) ?? [];
      } else {
        const headers: Record<string, string> = {};
        if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
        const r = await fetch(`${p.baseUrl}/models`, {
          headers,
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        models = ((await r.json()) as any).data?.map((m: any) => m.id) ?? [];
      }
      const found = models.filter(Boolean);
      // Persist discovered models: previously they lived only in the
      // dashboard's React state / the in-memory provider object, so a page
      // refresh or gateway restart lost them. They are stored per provider
      // and unioned back in on every provider refresh (see server.ts).
      const prev = JSON.parse(store.getSetting(`discovered_models:${p.id}`) ?? "[]") as string[];
      const stored = [...new Set([...prev, ...found])];
      store.setSetting(`discovered_models:${p.id}`, JSON.stringify(stored));
      p.models = [...new Set([...p.models, ...found])];
      store.audit("provider.models_discovered", p.id, `${found.length} models`);
      res.json({ provider: p.id, models: p.models });
    } catch (err) {
      // Many providers (OAuth/Cloud Code/cookie/special) expose NO model
      // listing endpoint — discovery there used to hard-fail with a 502,
      // which looked like the gateway itself was down. Fall back to the
      // provider's known models instead; only a provider with no known
      // models at all still surfaces the upstream error.
      if (p.models.length > 0) {
        const prev = JSON.parse(store.getSetting(`discovered_models:${p.id}`) ?? "[]") as string[];
        store.setSetting(
          `discovered_models:${p.id}`,
          JSON.stringify([...new Set([...prev, ...p.models])]),
        );
        res.json({ provider: p.id, models: p.models, note: "upstream listing unavailable — known models" });
        return;
      }
      res.status(502).json({
        error: { message: `discovery failed: ${err instanceof Error ? err.message : String(err)}`, type: "upstream_error" },
      });
    }
  });

  app.post("/api/providers/:id/models/import", (req: Request, res: Response) => {
    const def = providers.find((x) => x.id === req.params.id);
    if (!def) {
      res.status(404).json({ error: { message: "unknown provider", type: "not_found" } });
      return;
    }
    const models = Array.isArray(req.body?.models)
      ? req.body.models.filter((m: unknown): m is string => typeof m === "string" && m.length > 0)
      : [];
    if (models.length === 0) {
      res.status(400).json({ error: { message: "models[] is required", type: "bad_request" } });
      return;
    }
    def.models = [...new Set([...def.models, ...models])];
    const prev = JSON.parse(store.getSetting(`discovered_models:${def.id}`) ?? "[]") as string[];
    store.setSetting(
      `discovered_models:${def.id}`,
      JSON.stringify([...new Set([...prev, ...models])]),
    );
    res.json({ provider: def.id, models: def.models });
  });

  // ---- Costs ----
  app.get("/api/costs/summary", (_req: Request, res: Response) => {
    const d = new Date();
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const byProvider = store.usageSummary(start).map((r) => ({
      provider: r.provider,
      model: r.model,
      requests: r.requests,
    }));
    // attach spend per provider from daily rollup
    const rows = store.dailySpend(31).reduce((s, x) => s + x.total, 0);
    res.json({
      monthToDateUsd: Math.round(rows * 1e6) / 1e6,
      byProvider,
      forecast: store.forecastMonthly(),
    });
  });

  app.get("/api/costs/forecast", (_req: Request, res: Response) => {
    res.json({ daily: store.dailySpend(7), ...store.forecastMonthly() });
  });

  app.get("/api/costs/export", (_req: Request, res: Response) => {
    const rows = store.usageSummary(0);
    const csv = [
      "provider,model,requests,prompt_tokens,completion_tokens,errors",
      ...rows.map((r) =>
        [r.provider, r.model, r.requests, r.promptTokens, r.completionTokens, r.errors].join(","),
      ),
    ].join("\n");
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", "attachment; filename=llmswitch-usage.csv");
    res.send(csv);
  });

  // ---- Key budgets ----
  app.put("/api/keys/:id/budget", (req: Request, res: Response) => {
    const v = req.body?.budgetUsd;
    const budget = v === null ? null : typeof v === "number" && v >= 0 ? v : undefined;
    if (budget === undefined) {
      res.status(400).json({ error: { message: "budgetUsd must be a number >= 0 or null", type: "bad_request" } });
      return;
    }
    const ok = store.setBudget(req.params.id, budget);
    if (ok) store.audit("key.budget", req.params.id, `budget=${budget}`);
    res.status(ok ? 200 : 404).json({ budgetUsd: budget });
  });

  app.post("/api/keys", (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : "default";
    const budgetUsd = typeof req.body?.budgetUsd === "number" && req.body.budgetUsd >= 0 ? req.body.budgetUsd : null;
    const { record, key } = store.createApiKey(name, 600, budgetUsd);
    store.audit("key.created", record.id, `name=${name}`);
    // raw key returned ONCE
    res.json({ ...record, key });
  });

  // ---- MITM debugging proxy (admin-gated via /api/* when ADMIN_KEY is set) ----
  registerMitmRoutes(app, { providers, inspector, store });

  // ---- Antigravity browser OAuth (callback exempt from admin gate; state-protected) ----
  registerAntigravityOAuthRoutes(app, { config, store, fetchFn: deps.fetchFn, onCredentialsChanged: deps.refreshProviders });

  // ---- Claude + Codex PKCE browser OAuth (same exemptions; mock-tested, needs live login) ----
  registerProviderOAuthRoutes(app, CLAUDE_OAUTH_FLOW, { config, store, fetchFn: deps.fetchFn, onCredentialsChanged: deps.refreshProviders });
  registerProviderOAuthRoutes(app, CODEX_OAUTH_FLOW, { config, store, fetchFn: deps.fetchFn, onCredentialsChanged: deps.refreshProviders });

  // ---- Skills (reusable system-prompt packs) ----
  const skills = new SkillRegistry();
  app.get("/api/skills", (_req: Request, res: Response) => {
    res.json({
      skills: skills.list().map((s) => ({
        name: s.name,
        description: s.description,
        model: s.model ?? null,
        source: s.source,
      })),
    });
  });
  app.post("/api/skills", (req: Request, res: Response) => {
    const b = req.body ?? {};
    try {
      const s = skills.save({
        name: String(b.name ?? ""),
        description: typeof b.description === "string" ? b.description : "",
        instructions: String(b.instructions ?? ""),
        model: typeof b.model === "string" ? b.model : undefined,
      });
      store.audit("skill.created", req.apiKey?.id ?? null, `name=${s.name}`);
      res.status(201).json({ name: s.name, description: s.description, model: s.model ?? null });
    } catch (e) {
      res.status(400).json({ error: { message: (e as Error).message, type: "bad_request" } });
    }
  });
  app.delete("/api/skills/:name", (req: Request, res: Response) => {
    const ok = skills.delete(req.params.name);
    if (ok) store.audit("skill.deleted", req.apiKey?.id ?? null, `name=${req.params.name}`);
    res.status(ok ? 200 : 404).json({ deleted: ok });
  });
  app.post("/v1/skills/:name/run", async (req: Request, res: Response) => {
    const skill = skills.get(req.params.name);
    if (!skill) {
      res.status(404).json({ error: { message: `unknown skill: ${req.params.name}`, type: "not_found" } });
      return;
    }
    const input = typeof req.body?.input === "string" ? req.body.input : "";
    if (!input.trim()) {
      res.status(400).json({ error: { message: "input is required", type: "bad_request" } });
      return;
    }
    const model = typeof req.body?.model === "string" ? req.body.model : undefined;
    try {
      const r = await skills.run(skill, input, router, model);
      store.logUsage({
        keyId: req.apiKey?.id ?? null,
        provider: r.providerId,
        model: r.model,
        promptTokens: r.usage.prompt_tokens,
        completionTokens: r.usage.completion_tokens,
        latencyMs: r.latencyMs,
        status: "ok",
        costUsd: r.costUsd,
      });
      res.json({
        skill: r.skill,
        output: r.output,
        provider: r.providerId,
        model: r.model,
        usage: r.usage,
        cost_usd: r.costUsd,
      });
    } catch (e) {
      res.status(502).json({ error: { message: (e as Error).message, type: "upstream_error" } });
    }
  });

  // ---- Combo chains (sequential multi-model pipelines) ----
  app.get("/api/combos", (_req: Request, res: Response) => {
    res.json({
      combos: store.listCombos().map((c) => ({
        name: c.name,
        description: c.description ?? null,
        steps: c.steps,
      })),
    });
  });
  app.post("/api/combos", (req: Request, res: Response) => {
    try {
      const v = validateCombo(req.body);
      store.saveCombo(v.name, { description: v.description, steps: v.steps });
      store.audit("combo.created", req.apiKey?.id ?? null, `name=${v.name}`);
      res.status(201).json({ name: v.name, steps: v.steps });
    } catch (e) {
      res.status(400).json({ error: { message: (e as Error).message, type: "bad_request" } });
    }
  });
  app.delete("/api/combos/:name", (req: Request, res: Response) => {
    const ok = store.deleteCombo(req.params.name);
    if (ok) store.audit("combo.deleted", req.apiKey?.id ?? null, `name=${req.params.name}`);
    res.status(ok ? 200 : 404).json({ deleted: ok });
  });
  app.post("/v1/combos/:name/run", async (req: Request, res: Response) => {
    const def = store.getCombo(req.params.name);
    if (!def) {
      res.status(404).json({ error: { message: `unknown combo: ${req.params.name}`, type: "not_found" } });
      return;
    }
    const input = typeof req.body?.input === "string" ? req.body.input : "";
    if (!input.trim()) {
      res.status(400).json({ error: { message: "input is required", type: "bad_request" } });
      return;
    }
    try {
      const combo: Combo = { name: def.name, description: def.description, steps: def.steps, createdAt: def.createdAt };
      const r = await runCombo(combo, input, router);
      for (const s of r.steps) {
        store.logUsage({
          keyId: req.apiKey?.id ?? null,
          provider: s.providerId,
          model: s.model,
          promptTokens: s.usage.prompt_tokens,
          completionTokens: s.usage.completion_tokens,
          latencyMs: s.latencyMs,
          status: "ok",
          costUsd: s.costUsd,
        });
      }
      res.json({
        combo: r.combo,
        steps: r.steps.map((s) => ({
          step: s.step,
          model: s.model,
          provider: s.providerId,
          output: s.output,
          usage: s.usage,
          cost_usd: s.costUsd,
          latency_ms: s.latencyMs,
        })),
        total_cost_usd: r.totalCostUsd,
        total_latency_ms: r.totalLatencyMs,
      });
    } catch (e) {
      res.status(502).json({ error: { message: (e as Error).message, type: "upstream_error" } });
    }
  });
}
