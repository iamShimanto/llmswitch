import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ApiKeyRecord {
  id: string;
  name: string;
  rpmLimit: number;
  budgetUsd: number | null;
  workspaceId: string;
}

export interface Workspace {
  id: string;
  name: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_salt TEXT NOT NULL,
  rpm_limit INTEGER NOT NULL DEFAULT 600,
  budget_usd REAL,
  workspace_id TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
CREATE TABLE IF NOT EXISTS request_logs (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  key_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  request_preview TEXT NOT NULL DEFAULT '',
  response_preview TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(ts);
CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(provider);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  key_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS combos (
  name TEXT PRIMARY KEY,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

/** API keys are stored as scrypt hashes — the raw key is shown once at creation. */
export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "llmswitch.db"));
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for existing databases. */
  private migrate(): void {
    const cols = (table: string): Set<string> =>
      new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    if (!cols("usage_log").has("cost_usd")) {
      this.db.exec("ALTER TABLE usage_log ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
    }
    if (!cols("api_keys").has("budget_usd")) {
      this.db.exec("ALTER TABLE api_keys ADD COLUMN budget_usd REAL");
    }
    if (!cols("api_keys").has("workspace_id")) {
      this.db.exec("ALTER TABLE api_keys ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default'");
    }
    // ensure the default workspace exists
    this.db
      .prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('default', 'Default', ?)")
      .run(Date.now());
  }

  createApiKey(
    name: string,
    rpmLimit = 600,
    budgetUsd: number | null = null,
    workspaceId = "default",
  ): { record: ApiKeyRecord; key: string } {
    const key = `lsk_${randomBytes(24).toString("hex")}`;
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(key, salt, 64).toString("hex");
    const id = randomBytes(8).toString("hex");
    this.db
      .prepare(
        "INSERT INTO api_keys (id, name, key_hash, key_salt, rpm_limit, budget_usd, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, name, hash, salt, rpmLimit, budgetUsd, workspaceId, Date.now());
    return { record: { id, name, rpmLimit, budgetUsd, workspaceId }, key };
  }

  verifyApiKey(key: string): ApiKeyRecord | null {
    if (!key.startsWith("lsk_")) return null;
    const rows = this.db.prepare("SELECT * FROM api_keys").all() as Array<{
      id: string;
      name: string;
      key_hash: string;
      key_salt: string;
      rpm_limit: number;
      budget_usd: number | null;
      workspace_id: string;
    }>;
    for (const r of rows) {
      const hash = scryptSync(key, r.key_salt, 64);
      const stored = Buffer.from(r.key_hash, "hex");
      if (hash.length === stored.length && timingSafeEqual(hash, stored)) {
        return { id: r.id, name: r.name, rpmLimit: r.rpm_limit, budgetUsd: r.budget_usd, workspaceId: r.workspace_id };
      }
    }
    return null;
  }

  listApiKeys(): ApiKeyRecord[] {
    const rows = this.db
      .prepare("SELECT id, name, rpm_limit, budget_usd, workspace_id FROM api_keys")
      .all() as Array<{
      id: string;
      name: string;
      rpm_limit: number;
      budget_usd: number | null;
      workspace_id: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      rpmLimit: r.rpm_limit,
      budgetUsd: r.budget_usd,
      workspaceId: r.workspace_id,
    }));
  }

  setBudget(id: string, budgetUsd: number | null): boolean {
    const res = this.db.prepare("UPDATE api_keys SET budget_usd = ? WHERE id = ?").run(budgetUsd, id);
    return res.changes > 0;
  }

  revokeApiKey(id: string): boolean {
    const res = this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
    return res.changes > 0;
  }

  private requestLogWrites = 0;

  /** Persist one request-log row (from an inspector entry). Retention: 5000. */
  logRequest(e: {
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
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO request_logs
           (id, ts, key_id, provider, model, strategy, status, latency_ms,
            prompt_tokens, completion_tokens, cost_usd, cached, request_preview, response_preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.ts,
        e.keyId,
        e.provider,
        e.model,
        e.strategy,
        e.status,
        Math.round(e.latencyMs),
        e.promptTokens,
        e.completionTokens,
        e.costUsd,
        e.cached ? 1 : 0,
        JSON.stringify(e.request).slice(0, 4000),
        (e.responsePreview ?? "").slice(0, 1000),
      );
    // amortized retention trim
    if (++this.requestLogWrites % 100 === 0) {
      this.db.exec(
        `DELETE FROM request_logs WHERE id IN (
           SELECT id FROM request_logs ORDER BY ts DESC LIMIT -1 OFFSET 5000
         )`,
      );
    }
  }

  /** Filtered, paginated request-log query (OmniRoute-style logs page). */
  queryLogs(f: {
    provider?: string;
    model?: string;
    status?: string;
    keyId?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }): { total: number; logs: Array<Record<string, unknown>> } {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.provider) { where.push("provider = ?"); args.push(f.provider); }
    if (f.model) { where.push("model LIKE ?"); args.push(`%${f.model}%`); }
    if (f.status) { where.push("status = ?"); args.push(f.status); }
    if (f.keyId) { where.push("key_id = ?"); args.push(f.keyId); }
    if (f.q) {
      where.push("(provider LIKE ? OR model LIKE ? OR response_preview LIKE ?)");
      args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM request_logs ${clause}`).get(...args) as { n: number }
    ).n;
    const limit = Math.min(200, Math.max(1, f.limit ?? 50));
    const offset = Math.max(0, f.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT id, ts, key_id, provider, model, strategy, status, latency_ms,
                prompt_tokens, completion_tokens, cost_usd, cached,
                request_preview, response_preview
         FROM request_logs ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as Array<Record<string, unknown>>;
    return {
      total,
      logs: rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        keyId: r.key_id,
        provider: r.provider,
        model: r.model,
        strategy: r.strategy,
        status: r.status,
        latencyMs: r.latency_ms,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        costUsd: r.cost_usd,
        cached: r.cached === 1,
        request: JSON.parse(String(r.request_preview || "[]")),
        responsePreview: r.response_preview,
      })),
    };
  }

  /** Most recent usage rows (newest first) — seeds the Live/Activity feed. */
  recentUsage(limit = 50): Array<{
    ts: number;
    keyId: string | null;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    status: string;
    costUsd: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT ts, key_id, provider, model, prompt_tokens, completion_tokens, latency_ms, status, cost_usd
         FROM usage_log ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      ts: Number(r.ts),
      keyId: (r.key_id as string | null) ?? null,
      provider: String(r.provider),
      model: String(r.model),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      latencyMs: Number(r.latency_ms),
      status: String(r.status),
      costUsd: Number(r.cost_usd),
    }));
  }

  logUsage(entry: {
    keyId: string | null;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    status: string;
    costUsd?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_log (ts, key_id, provider, model, prompt_tokens, completion_tokens, latency_ms, status, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        entry.keyId,
        entry.provider,
        entry.model,
        entry.promptTokens,
        entry.completionTokens,
        entry.latencyMs,
        entry.status,
        entry.costUsd ?? 0,
      );
  }

  /** USD spent by a key since the start of the current month (UTC). */
  monthSpend(keyId: string, now = Date.now()): number {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_log WHERE key_id = ? AND ts >= ?")
      .get(keyId, start) as { total: number };
    return row.total;
  }

  /** Runtime settings overrides (dashboard-editable; env vars remain the default). */
  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as {
      value: string;
    } | undefined;
    return row?.value ?? null;
  }

  /** Dashboard login sessions (hashed tokens) — persisted so logins survive restarts/deploys. */
  createDashboardSession(tokenHash: string, expiresAt: number): void {
    this.db
      .prepare("INSERT OR REPLACE INTO dashboard_sessions (token_hash, expires_at) VALUES (?, ?)")
      .run(tokenHash, expiresAt);
  }

  dashboardSessionExpiry(tokenHash: string): number | null {
    const row = this.db
      .prepare("SELECT expires_at FROM dashboard_sessions WHERE token_hash = ?")
      .get(tokenHash) as { expires_at: number } | undefined;
    return row ? row.expires_at : null;
  }

  deleteDashboardSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM dashboard_sessions WHERE token_hash = ?").run(tokenHash);
  }

  clearDashboardSessions(): void {
    this.db.prepare("DELETE FROM dashboard_sessions").run();
  }

  /** All settings whose key starts with `prefix`, as a record. */
  listSettings(prefix: string): Record<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ?")
      .all(`${prefix}%`) as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  deleteSetting(key: string): void {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Total USD spend across all keys for the current calendar month. */
  totalMonthSpend(now = Date.now()): number {
    const d = new Date(now);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_log WHERE ts >= ?")
      .get(start) as { total: number };
    return row.total;
  }

  /** Daily request counts + spend for the last N days (oldest → newest). */
  /** Full analytics aggregate over usage_log since a timestamp. */
  analyticsSummary(sinceTs: number, keyId?: string): {
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
    byModel: Array<{
      model: string;
      provider: string;
      requests: number;
      tokens: number;
      costUsd: number;
    }>;
  } {
    const keyClause = keyId ? " AND key_id = ?" : "";
    const args = keyId ? [sinceTs, keyId] : [sinceTs];
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS inputTokens,
                COALESCE(SUM(completion_tokens), 0) AS outputTokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd,
                COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
         FROM usage_log WHERE ts >= ?${keyClause}`,
      )
      .get(...args) as Record<string, number>;
    const series = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day,
                COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS inputTokens,
                COALESCE(SUM(completion_tokens), 0) AS outputTokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM usage_log WHERE ts >= ?${keyClause}
         GROUP BY day ORDER BY day ASC`,
      )
      .all(...args) as Array<Record<string, unknown>>;
    const byProvider = this.db
      .prepare(
        `SELECT provider, COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(prompt_tokens), 0) AS inputTokens,
                COALESCE(SUM(completion_tokens), 0) AS outputTokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd,
                COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
         FROM usage_log WHERE ts >= ?${keyClause}
         GROUP BY provider ORDER BY requests DESC`,
      )
      .all(...args) as Array<Record<string, unknown>>;
    const byModel = this.db
      .prepare(
        `SELECT model, provider, COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
                COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM usage_log WHERE ts >= ?${keyClause}
         GROUP BY model, provider ORDER BY requests DESC LIMIT 12`,
      )
      .all(...args) as Array<Record<string, unknown>>;
    const num = (v: unknown) => Number(v ?? 0);
    return {
      totals: {
        requests: num(totals.requests),
        errors: num(totals.errors),
        inputTokens: num(totals.inputTokens),
        outputTokens: num(totals.outputTokens),
        costUsd: num(totals.costUsd),
        avgLatencyMs: num(totals.avgLatencyMs),
      },
      series: series.map((r) => ({
        day: String(r.day),
        requests: num(r.requests),
        errors: num(r.errors),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        costUsd: num(r.costUsd),
      })),
      byProvider: byProvider.map((r) => ({
        provider: String(r.provider),
        requests: num(r.requests),
        errors: num(r.errors),
        inputTokens: num(r.inputTokens),
        outputTokens: num(r.outputTokens),
        costUsd: num(r.costUsd),
        avgLatencyMs: num(r.avgLatencyMs),
      })),
      byModel: byModel.map((r) => ({
        model: String(r.model),
        provider: String(r.provider),
        requests: num(r.requests),
        tokens: num(r.tokens),
        costUsd: num(r.costUsd),
      })),
    };
  }

  dailyRequests(days = 30, now = Date.now()): Array<{ day: string; requests: number; errors: number; costUsd: number }> {
    const out: Array<{ day: string; requests: number; errors: number; costUsd: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now - i * 86_400_000);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = dayStart.getTime() + 86_400_000;
      const row = this.db
        .prepare(
          "SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS errors, COALESCE(SUM(cost_usd), 0) AS costUsd FROM usage_log WHERE ts >= ? AND ts < ?",
        )
        .get(dayStart.getTime(), dayEnd) as { requests: number; errors: number; costUsd: number };
      out.push({
        day: dayStart.toISOString().slice(0, 10),
        requests: row.requests,
        errors: row.errors,
        costUsd: Math.round(row.costUsd * 1e6) / 1e6,
      });
    }
    return out;
  }

  /** Daily USD spend totals for the last N days (oldest → newest). */
  dailySpend(days = 7, now = Date.now()): Array<{ day: string; total: number }> {
    const out: Array<{ day: string; total: number }> = [];
    for (let i = days - 1; i >= 0; i--) {
      const dayStart = new Date(now - i * 86_400_000);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = dayStart.getTime() + 86_400_000;
      const row = this.db
        .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_log WHERE ts >= ? AND ts < ?")
        .get(dayStart.getTime(), dayEnd) as { total: number };
      out.push({ day: dayStart.toISOString().slice(0, 10), total: Math.round(row.total * 1e6) / 1e6 });
    }
    return out;
  }

  /** Linear forecast: avg daily spend (last 7d) × 30. */
  forecastMonthly(): { dailyAvg: number; projectedMonthly: number } {
    const days = this.dailySpend(7);
    const total = days.reduce((s, d) => s + d.total, 0);
    const dailyAvg = total / 7;
    return {
      dailyAvg: Math.round(dailyAvg * 1e6) / 1e6,
      projectedMonthly: Math.round(dailyAvg * 30 * 1e6) / 1e6,
    };
  }

  usageSummary(sinceMs = 0): Array<{
    provider: string;
    model: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    errors: number;
  }> {
    return this.db
      .prepare(
        `SELECT provider, model,
                COUNT(*) AS requests,
                SUM(prompt_tokens) AS promptTokens,
                SUM(completion_tokens) AS completionTokens,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors
         FROM usage_log WHERE ts >= ? GROUP BY provider, model ORDER BY requests DESC`,
      )
      .all(sinceMs) as Array<{
      provider: string;
      model: string;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      errors: number;
    }>;
  }

  /** Append an audit event. Never throws. */
  audit(action: string, keyId: string | null = null, detail = ""): void {
    try {
      this.db
        .prepare("INSERT INTO audit_log (ts, key_id, action, detail) VALUES (?, ?, ?, ?)")
        .run(Date.now(), keyId, action, detail.slice(0, 2000));
    } catch {
      /* audit must never break the request */
    }
  }

  /** Combo chains (persisted). */
  saveCombo(name: string, definition: { description?: string; steps: Array<{ model: string; system?: string }> }): void {
    this.db
      .prepare(
        "INSERT INTO combos (name, definition, created_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET definition=excluded.definition",
      )
      .run(name, JSON.stringify(definition), Date.now());
  }

  getCombo(name: string): { name: string; description?: string; steps: Array<{ model: string; system?: string }>; createdAt: number } | null {
    const row = this.db.prepare("SELECT * FROM combos WHERE name = ?").get(name) as
      | { name: string; definition: string; created_at: number }
      | undefined;
    if (!row) return null;
    try {
      const def = JSON.parse(row.definition) as { description?: string; steps: Array<{ model: string; system?: string }> };
      return { name: row.name, description: def.description, steps: def.steps, createdAt: row.created_at };
    } catch {
      return null;
    }
  }

  listCombos(): Array<{ name: string; description?: string; steps: Array<{ model: string; system?: string }>; createdAt: number }> {
    const rows = this.db.prepare("SELECT * FROM combos ORDER BY name").all() as Array<{
      name: string;
      definition: string;
      created_at: number;
    }>;
    const out: Array<{ name: string; description?: string; steps: Array<{ model: string; system?: string }>; createdAt: number }> = [];
    for (const row of rows) {
      try {
        const def = JSON.parse(row.definition) as { description?: string; steps: Array<{ model: string; system?: string }> };
        out.push({ name: row.name, description: def.description, steps: def.steps, createdAt: row.created_at });
      } catch {
        /* skip corrupt rows */
      }
    }
    return out;
  }

  deleteCombo(name: string): boolean {
    const r = this.db.prepare("DELETE FROM combos WHERE name = ?").run(name);
    return (r as unknown as { changes: number }).changes > 0;
  }

  listAudit(limit = 100): Array<{ id: number; ts: number; keyId: string | null; action: string; detail: string }> {
    return this.db
      .prepare("SELECT id, ts, key_id AS keyId, action, detail FROM audit_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(limit, 500)) as Array<{
      id: number;
      ts: number;
      keyId: string | null;
      action: string;
      detail: string;
    }>;
  }

  /** Workspaces (teams). The 'default' workspace always exists. */
  private ensureDefaultWorkspace(): void {
    this.db
      .prepare("INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES ('default', 'Default', ?)")
      .run(Date.now());
  }

  createWorkspace(name: string): Workspace {
    this.ensureDefaultWorkspace();
    const id = randomBytes(8).toString("hex");
    this.db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").run(id, name, Date.now());
    return { id, name };
  }

  listWorkspaces(): Workspace[] {
    this.ensureDefaultWorkspace();
    return this.db.prepare("SELECT id, name FROM workspaces ORDER BY name").all() as unknown as Workspace[];
  }

  setKeyWorkspace(keyId: string, workspaceId: string): boolean {
    const ws = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (!ws) return false;
    const res = this.db.prepare("UPDATE api_keys SET workspace_id = ? WHERE id = ?").run(workspaceId, keyId);
    return res.changes > 0;
  }

  workspaceSpend(workspaceId: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_log
         WHERE ts >= ? AND key_id IN (SELECT id FROM api_keys WHERE workspace_id = ?)`,
      )
      .get(sinceMs, workspaceId) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}

/** Test helper: in-memory store. */
export function memoryStore(): Store {
  const s = Object.create(Store.prototype) as Store;
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  (s as any).db = db;
  return s;
}

export { dirname };
