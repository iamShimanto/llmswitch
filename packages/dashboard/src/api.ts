/** Typed client for the gateway's dashboard API. */

export interface CatalogEntry {
  id: string;
  name: string;
  wireFormat: string;
  authType: string;
  envKey: string;
  models: string[];
  defaultModel: string;
  connected: boolean;
  disabled: boolean;
  enabled: boolean;
  hiddenModels: string[];
  customModels: Array<{ id: string; name?: string }>;
  accountStrategy: string | null;
  blockedParams: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  wireFormat: string;
  /** "api-key" | "oauth" | "token-import" | "none" — "none" = keyless */
  authType?: string;
  models: string[];
  defaultModel: string;
  stats: { calls: number; errors: number; totalLatencyMs: number };
}

export interface UsageRow {
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  errors: number;
}

export interface KeyRecord {
  id: string;
  name: string;
  rpmLimit: number;
  budgetUsd: number | null;
  workspaceId: string;
  monthSpendUsd?: number;
}

export interface CostByProvider {
  provider: string;
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  priced: boolean;
}

export interface PricingTable {
  exact: Array<{ key: string; input: number; output: number }>;
  patterns: Array<{ label: string; input: number; output: number }>;
  providers: Array<{ key: string; input: number; output: number }>;
  overrides: Record<string, { input: number; output: number }>;
}

export interface Workspace {
  id: string;
  name: string;
}

export interface OAuthStatus {
  connected: boolean;
  email?: string;
  projectId?: string;
  accountId?: string;
  expiresAt?: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const adminKey = localStorage.getItem("llmswitch_admin_key");
  const session = localStorage.getItem("llmswitch_session");
  const { headers: initHeaders, ...rest } = init ?? {};
  const res = await fetch(path, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(adminKey ? { "x-admin-key": adminKey } : {}),
      ...(session ? { "x-dashboard-session": session } : {}),
      ...(initHeaders ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export function getAdminKey(): string {
  return localStorage.getItem("llmswitch_admin_key") ?? "";
}

export function getSession(): string {
  return localStorage.getItem("llmswitch_session") ?? "";
}

export function setSession(t: string): void {
  if (t) localStorage.setItem("llmswitch_session", t);
  else localStorage.removeItem("llmswitch_session");
}

export interface AuthStatus {
  required: boolean;
  isDefault: boolean;
}

export const authApi = {
  status: () => req<AuthStatus>("/api/auth/status"),
  me: () => req<{ ok: boolean; isDefault: boolean }>("/api/auth/me"),
  login: (password: string) =>
    req<{ token: string; isDefault: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () => req<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: boolean; token: string }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

export function setAdminKey(k: string): void {
  if (k) localStorage.setItem("llmswitch_admin_key", k);
  else localStorage.removeItem("llmswitch_admin_key");
}

export const api = {
  health: () => req<{ status: string; version: string; providers: string[] }>("/healthz"),
  providers: () => req<ProviderInfo[]>("/api/providers"),
  usage: () => req<UsageRow[]>("/api/usage"),
  keys: () => req<KeyRecord[]>("/api/keys"),
  createKey: (name: string, budgetUsd?: number | null) =>
    req<KeyRecord & { key: string }>("/api/keys", {
      method: "POST",
      body: JSON.stringify({ name, budgetUsd: budgetUsd ?? null }),
    }),
  revokeKey: (id: string) => req<{ revoked: boolean }>(`/api/keys/${id}`, { method: "DELETE" }),
  setBudget: (id: string, budgetUsd: number | null) =>
    req(`/api/keys/${id}/budget`, { method: "PUT", body: JSON.stringify({ budgetUsd }) }),
  backups: () =>
    req<{ backups: Array<{ name: string; sizeBytes: number; createdAt: number }> }>("/api/backups"),
  createBackup: () =>
    req<{ ok: boolean; backup: { name: string; sizeBytes: number; createdAt: number } }>("/api/backups", {
      method: "POST",
      body: "{}",
    }),
  deleteBackup: (name: string) =>
    req<{ ok: boolean }>(`/api/backups/${encodeURIComponent(name)}`, { method: "DELETE" }),
  restoreBackup: (name: string) =>
    req<{ ok: boolean; restartRequired: boolean }>(`/api/backups/${encodeURIComponent(name)}/restore`, {
      method: "POST",
      body: "{}",
    }),
  downloadBackup: async (name: string): Promise<void> => {
    const adminKey = localStorage.getItem("llmswitch_admin_key");
    const session = localStorage.getItem("llmswitch_session");
    const res = await fetch(`/api/backups/${encodeURIComponent(name)}/download`, {
      headers: {
        ...(adminKey ? { "x-admin-key": adminKey } : {}),
        ...(session ? { "x-dashboard-session": session } : {}),
      },
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
  circuitBreakers: () =>
    req<{
      breakers: Array<{
        key: string;
        providerId: string;
        model: string;
        failures: number;
        lastKind: string;
        lastError: string;
        open: boolean;
        retryInMs: number;
      }>;
    }>("/api/circuit-breakers"),
  resetBreaker: (key?: string) =>
    req<{ ok: boolean }>("/api/circuit-breakers/reset", {
      method: "POST",
      body: JSON.stringify(key ? { key } : {}),
    }),
  cacheStats: () =>
    req<{
      exact: {
        entries: number;
        hits: number;
        misses: number;
        hitRate: number;
        persistent: boolean;
        ttlMs: number;
        maxEntries: number;
      };
      semantic: { entries: number; hits: number; misses: number; hitRate: number; threshold: number } | null;
    }>("/api/cache/stats"),
  clearCache: () => req<{ cleared: boolean }>("/api/cache", { method: "DELETE" }),
  compressionPreview: (text: string, mode = "stacked") =>
    req<{ text: string; stats: { savedPct: number; estTokensBefore: number; estTokensAfter: number } }>(
      "/api/compression/preview",
      { method: "POST", body: JSON.stringify({ text, mode }) },
    ),
  inspector: () => req<InspectEntry[]>("/api/inspector"),
  inspectorGet: (id: string) => req<InspectEntry>(`/api/inspector/${id}`),
  playground: (messages: Array<{ role: string; content: string }>, providers: string[]) =>
    req<{ results: FanoutResult[] }>("/api/playground", {
      method: "POST",
      body: JSON.stringify({ messages, providers }),
    }),
  discover: (id: string) => req<{ provider: string; models: string[] }>(`/api/providers/${id}/discover`),
  catalog: () => req<CatalogEntry[]>("/api/catalog"),
  saveProviderKey: (id: string, key: string, accountLabel?: string) =>
    req<{ ok: boolean; connected: boolean; accountId?: string }>(`/api/providers/${id}/key`, {
      method: "POST",
      body: JSON.stringify({ key, ...(accountLabel ? { accountLabel } : {}) }),
    }),
  removeProviderKey: (id: string) =>
    req<{ ok: boolean; connected: boolean }>(`/api/providers/${id}/key`, { method: "DELETE" }),
  testModel: (id: string, model: string) =>
    req<{ ok: boolean; model: string; latencyMs: number; text?: string; error?: string }>(
      `/api/providers/${id}/test`,
      { method: "POST", body: JSON.stringify({ model }) },
    ),
  workspaces: () => req<Workspace[]>("/api/workspaces"),
  createWorkspace: (name: string) =>
    req<Workspace>("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
  setKeyWorkspace: (id: string, workspaceId: string) =>
    req(`/api/keys/${id}/workspace`, { method: "PUT", body: JSON.stringify({ workspaceId }) }),
  audit: () => req<Array<{ id: number; ts: number; action: string; detail: string }>>("/api/audit"),
  costsSummary: () =>
    req<{
      monthToDateUsd: number;
      forecast: { projectedMonthly: number };
      byProvider: CostByProvider[];
      coverage: { pricedRequests: number; totalRequests: number; pct: number };
    }>("/api/costs/summary"),
  costsPricing: () => req<PricingTable>("/api/costs/pricing"),
  savePriceOverride: (key: string, input: number, output: number) =>
    req<{ ok: boolean }>("/api/costs/pricing/override", {
      method: "POST",
      body: JSON.stringify({ key, input, output }),
    }),
  deletePriceOverride: (key: string) =>
    req<{ ok: boolean }>("/api/costs/pricing/override", {
      method: "DELETE",
      body: JSON.stringify({ key }),
    }),
  costsForecast: () =>
    req<{ daily: Array<{ day: string; total: number }>; projectedMonthly: number }>("/api/costs/forecast"),
  quotas: () => req<{ providers: QuotaProvider[] }>("/api/quotas"),
  usageDaily: (days = 30) => req<{ days: DailyUsageRow[] }>(`/api/usage/daily?days=${days}`),
  logs: (params: {
    provider?: string;
    model?: string;
    status?: string;
    key?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    return req<{ total: number; logs: RequestLogRow[] }>(`/api/logs?${qs.toString()}`);
  },
  analyticsSummary: (days = 30, keyId?: string) =>
    req<AnalyticsSummary>(
      `/api/analytics/summary?days=${days}${keyId ? `&key=${encodeURIComponent(keyId)}` : ""}`,
    ),
  sessions: () => req<{ sessions: SessionMeta[] }>("/api/sessions"),
  importSession: (provider: string, cookies: string, cookieDomain?: string, accessToken?: string, accountLabel?: string) =>
    req<{ ok: boolean; connected: boolean; accountId?: string }>("/api/sessions/import", {
      method: "POST",
      body: JSON.stringify({ provider, cookies, cookieDomain, ...(accessToken ? { accessToken } : {}), ...(accountLabel ? { accountLabel } : {}) }),
    }),
  museDeviceStart: (accountLabel?: string) =>
    req<{ state: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>(
      "/api/oauth/muse-code/device/start",
      { method: "POST", body: JSON.stringify(accountLabel ? { accountLabel } : {}) },
    ),
  museDevicePoll: (state: string) =>
    req<{ status: string; email?: string; tier?: string; subsActive?: boolean; requirePayment?: boolean; error?: string }>(
      "/api/oauth/muse-code/device/poll",
      { method: "POST", body: JSON.stringify({ state }) },
    ),
  museStatus: () =>
    req<{ connected: boolean; email?: string; tier?: string; subsActive?: boolean; requirePayment?: boolean }>(
      "/api/oauth/muse-code/status",
    ),
  museDisconnect: () =>
    req<{ ok: boolean; connected: boolean }>("/api/oauth/muse-code", { method: "DELETE" }),
  deleteSession: (name: string) =>
    req<{ deleted: boolean }>(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" }),
  batches: () => req<{ object: string; data: BatchJob[]; supported?: boolean }>("/api/batches"),
  cancelBatch: (id: string) =>
    req<unknown>(`/api/batches/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  oauthAntigravityStart: () => req<{ url: string }>("/api/oauth/antigravity/start"),
  oauthAntigravityStatus: () => req<OAuthStatus>("/api/oauth/antigravity/status"),
  oauthAntigravityDisconnect: () =>
    req<{ connected: boolean }>("/api/oauth/antigravity/disconnect", { method: "POST" }),
  oauthStart: (id: string) => req<{ url: string }>(`/api/oauth/${id}/start`),
  oauthTokenSave: (id: string, accessToken: string, refreshToken?: string, accountLabel?: string) =>
    req<{ ok: boolean; connected: boolean; accountId?: string }>(`/api/oauth/${id}/token`, {
      method: "POST",
      body: JSON.stringify({ accessToken, refreshToken, ...(accountLabel ? { accountLabel } : {}) }),
    }),
  oauthTokenRemove: (id: string) =>
    req<{ ok: boolean; connected: boolean }>(`/api/oauth/${id}/token`, { method: "DELETE" }),
  oauthComplete: (id: string, url: string, accountLabel?: string) =>
    req<{ connected: boolean; email?: string | null; accountId?: string }>(`/api/oauth/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ url, ...(accountLabel ? { accountLabel } : {}) }),
    }),
  oauthStatus: (id: string) => req<OAuthStatus>(`/api/oauth/${id}/status`),
  oauthDisconnect: (id: string) =>
    req<{ connected: boolean }>(`/api/oauth/${id}/disconnect`, { method: "POST" }),
  accounts: (providerId?: string) =>
    req<{ accounts: ProviderAccount[] }>(
      `/api/accounts${providerId ? `?provider=${encodeURIComponent(providerId)}` : ""}`,
    ),
  updateAccount: (id: string, patch: { label?: string; enabled?: boolean; dailyCapUsd?: number | null }) =>
    req<{ ok: boolean }>(`/api/accounts/${id}`, { method: "POST", body: JSON.stringify(patch) }),
  deleteAccount: (id: string) => req<{ ok: boolean }>(`/api/accounts/${id}`, { method: "DELETE" }),
  combos: () => req<{ combos: ServerCombo[] }>("/api/combos"),
  saveCombo: (def: {
    name: string;
    description?: string;
    strategy?: string;
    targets?: ComboTarget[];
    steps?: Array<{ model: string; system?: string }>;
    config?: ComboConfig;
    enabled?: boolean;
  }) => req<{ name: string; kind: string }>("/api/combos", { method: "POST", body: JSON.stringify(def) }),
  deleteCombo: (name: string) =>
    req<{ deleted: boolean }>(`/api/combos?name=${encodeURIComponent(name)}`, { method: "DELETE" }),
  testCombo: (name: string) =>
    req<ComboTestResult>("/api/combos/test", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  autoCatalog: () => req<{ templates: AutoTemplateInfo[] }>("/api/combos/auto-catalog"),
  setProviderEnabled: (id: string, enabled: boolean) =>
    req<{ ok: boolean; enabled: boolean }>(`/api/providers/${id}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  setProviderAccountStrategy: (id: string, strategy: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}/account-strategy`, {
      method: "POST",
      body: JSON.stringify({ strategy }),
    }),
  setModelVisibility: (id: string, model: string, hidden: boolean) =>
    req<{ ok: boolean; hiddenModels: string[] }>(`/api/providers/${id}/models/visibility`, {
      method: "POST",
      body: JSON.stringify({ model, hidden }),
    }),
  saveCustomModel: (id: string, model: string, name?: string, remove = false) =>
    req<{ ok: boolean; customModels: Array<{ id: string; name?: string }> }>(
      `/api/providers/${id}/models/custom`,
      { method: "POST", body: JSON.stringify({ model, name, remove }) },
    ),
  setParamBlock: (id: string, params: string) =>
    req<{ ok: boolean }>(`/api/providers/${id}/param-block`, {
      method: "POST",
      body: JSON.stringify({ params }),
    }),
  setDefaultModel: (id: string, model: string) =>
    req<{ ok: boolean; defaultModel: string }>(`/api/providers/${id}/default-model`, {
      method: "POST",
      body: JSON.stringify({ model }),
    }),
  resetDefaultModel: (id: string) =>
    req<{ ok: boolean; defaultModel: string }>(`/api/providers/${id}/default-model`, { method: "DELETE" }),
  routingRules: () => req<{ rules: RoutingRule[] }>("/api/routing-rules"),
  addRoutingRule: (pattern: string, providers: string[], strategy?: string) =>
    req<{ ok: boolean; rule: RoutingRule }>("/api/routing-rules", {
      method: "POST",
      body: JSON.stringify({ pattern, providers, strategy: strategy ?? "" }),
    }),
  updateRoutingRule: (
    id: string,
    patch: { pattern?: string; providers?: string[]; strategy?: string; enabled?: boolean },
  ) =>
    req<{ ok: boolean }>(`/api/routing-rules/${id}`, { method: "POST", body: JSON.stringify(patch) }),
  deleteRoutingRule: (id: string) =>
    req<{ ok: boolean }>(`/api/routing-rules/${id}`, { method: "DELETE" }),
  endpointInfo: () => req<EndpointInfo>("/api/endpoint-info"),
  getConfig: () => req<GatewayConfig>("/api/config"),
  putConfig: (patch: Partial<ConfigPatch>) =>
    req<GatewayConfig>("/api/config", { method: "PUT", body: JSON.stringify(patch) }),
};

export interface QuotaProvider {
  id: string;
  connected: boolean;
  calls: number;
  errors: number;
  telemetry: { remaining: number | null; limit: number | null; resetAt: number | null } | null;
  /** OmniRoute-style live quota groups (Antigravity retrieveUserQuota). */
  accountQuotas?: Array<{
    accountId: string | null;
    label: string;
    buckets: Array<{
      model: string;
      remainingPct: number | null;
      resetAt: string | null;
      unlimited: boolean;
    }>;
  }>;
}

export interface LiveStats {
  today: { requests: number; errors: number; inputTokens: number; outputTokens: number; costUsd: number };
  totalRequests: number;
  providersConnected: number;
}

export interface LiveHandlers {
  onSnapshot?: (entries: InspectEntry[], routing: unknown[]) => void;
  onRequest?: (entry: InspectEntry) => void;
  onRouting?: (event: unknown) => void;
  onStats?: (stats: LiveStats) => void;
  onStatus?: (connected: boolean) => void;
}

/**
 * Subscribe to the gateway's live event stream (/api/live, SSE over fetch so
 * the dashboard auth headers can ride along). Auto-reconnects. Returns an
 * unsubscribe function. Every dashboard page that wants real-time updates
 * uses this one channel.
 */
export function subscribeLive(handlers: LiveHandlers): () => void {
  let aborted = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const connect = async () => {
    try {
      controller = new AbortController();
      const headers: Record<string, string> = {};
      const ak = getAdminKey();
      const sess = getSession();
      if (ak) headers["x-admin-key"] = ak;
      if (sess) headers["x-dashboard-session"] = sess;
      const res = await fetch("/api/live", { headers, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      handlers.onStatus?.(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || aborted) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (event === "snapshot") handlers.onSnapshot?.(parsed.entries ?? [], parsed.routing ?? []);
            else if (event === "request") handlers.onRequest?.(parsed as InspectEntry);
            else if (event === "routing") handlers.onRouting?.(parsed);
            else if (event === "stats") handlers.onStats?.(parsed as LiveStats);
          } catch {
            /* ignore malformed events */
          }
        }
      }
    } catch {
      /* fall through to reconnect */
    }
    handlers.onStatus?.(false);
    if (!aborted) retry = setTimeout(connect, 3000);
  };

  connect();
  return () => {
    aborted = true;
    clearTimeout(retry);
    controller?.abort();
  };
}

export interface RequestLogRow {
  id: string;
  ts: number;
  keyId: string | null;
  provider: string;
  model: string;
  strategy: string;
  status: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  cached: boolean;
  request: Array<{ role: string; content: string }>;
  responsePreview: string;
}

export interface AnalyticsSummary {
  totals: {
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    avgLatencyMs: number;
  };
  series: Array<{
    day: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  byProvider: Array<{
    provider: string;
    requests: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    avgLatencyMs: number;
  }>;
  byModel: Array<{ model: string; provider: string; requests: number; tokens: number; costUsd: number }>;
  infra: { apiKeys: number; providersConnected: number; modelsTotal: number };
}

export interface DailyUsageRow {
  day: string;
  requests: number;
  errors: number;
  costUsd: number;
}

export interface SessionMeta {
  name: string;
  kind: string;
  provider: string | null;
  cookieDomain: string | null;
  expiresAt: number | null;
  savedAt: number | null;
}

export interface BatchJob {
  id: string;
  status?: string;
  endpoint?: string;
  created_at?: number;
  completed_at?: number | null;
  [k: string]: unknown;
}

export interface ConfigValue<T> {
  value: T;
  source: "db" | "env";
}

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  kind: "api_key" | "session";
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  calls: number;
  errors: number;
  lastError: string | null;
  dailyCapUsd?: number | null;
  spentTodayUsd?: number;
}

export interface ComboTarget {
  model: string;
  weight?: number;
  accountId?: string | null;
}

export interface ComboConfig {
  systemPrompt?: string;
  contextLength?: number;
  validation?: { forbidden?: string[]; required?: string[]; minLength?: number };
}

export interface AutoTemplateInfo {
  id: string;
  title: string;
  tags: string[];
  systemPrompt: string;
  strategy: string;
  candidates: number;
}

export interface ComboTestResult {
  ok: boolean;
  combo: string;
  resolvedBy: { target: string; provider: string; model: string } | null;
  results: Array<{
    target: string;
    accountId: string | null;
    ok: boolean;
    provider?: string;
    model?: string;
    latencyMs: number;
    text?: string;
    error?: string;
  }>;
}

export interface ServerCombo {
  name: string;
  description: string | null;
  kind: "router" | "pipeline";
  strategy: string | null;
  targets: ComboTarget[] | null;
  steps: Array<{ model: string; system?: string }> | null;
  config: ComboConfig | null;
  enabled: boolean;
}

export interface RoutingRule {
  id: string;
  pattern: string;
  providers: string[];
  strategy: string;
  enabled: boolean;
  createdAt: number;
}

export interface GatewayConfig {
  strategy: ConfigValue<string>;
  account_strategy: ConfigValue<string>;
  pii_redact: ConfigValue<boolean>;
  compression_default: ConfigValue<string | null>;
  alert_webhook_url: ConfigValue<string | null> & { enabled: boolean };
  budget_action: ConfigValue<string>;
  global_budget_usd: ConfigValue<number | null> & { spentMonthToDate: number };
  global_system_prompt: ConfigValue<string>;
  global_system_prompt_enabled: ConfigValue<boolean>;
}

export interface EndpointEntry {
  group: string;
  name: string;
  path: string;
  models: number | null;
  tag?: string;
  note?: string;
}

export interface EndpointInfo {
  version: string;
  port: number;
  totalModels: number;
  endpointCount: number;
  connectedProviders: number;
  endpoints: EndpointEntry[];
}

export interface ConfigPatch {
  strategy?: string;
  account_strategy?: string;
  pii_redact?: boolean;
  compression_default?: string | null;
  alert_webhook_url?: string | null;
  budget_action?: "warn" | "block";
  global_budget_usd?: number | null;
  global_system_prompt?: string | null;
  global_system_prompt_enabled?: boolean;
}

export interface FanoutResult {
  providerId: string;
  model: string;
  ok: boolean;
  text?: string;
  error?: string;
  latencyMs: number;
}

export interface InspectEntry {
  id: string;
  ts: number;
  keyId: string | null;
  provider: string;
  model: string;
  strategy: string;
  status: "ok" | "error";
  latencyMs: number;
  cached: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  request: Array<{ role: string; content: string }>;
  responsePreview: string;
}
