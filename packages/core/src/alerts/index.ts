/** Webhook alerts. Never throws — alerting must not break requests. */

export interface AlertEvent {
  type: "provider_down" | "provider_recovered" | "budget_exceeded" | "quota_low";
  severity: "info" | "warn" | "critical";
  message: string;
  data?: Record<string, unknown>;
}

export class Alerter {
  /** last alert ts per dedup key */
  private lastSent = new Map<string, number>();

  constructor(
    private webhookUrl: string | undefined = process.env.ALERT_WEBHOOK_URL,
    private dedupMs = 10 * 60_000,
    private fetchFn: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.webhookUrl;
  }

  get url(): string | undefined {
    return this.webhookUrl;
  }

  /** Runtime override (dashboard Settings). Pass undefined to clear. */
  setWebhookUrl(url: string | undefined): void {
    this.webhookUrl = url?.trim() ? url.trim() : undefined;
  }

  async send(event: AlertEvent, dedupKey?: string, now = Date.now()): Promise<boolean> {
    if (!this.webhookUrl) return false;
    if (dedupKey) {
      const last = this.lastSent.get(dedupKey) ?? 0;
      if (now - last < this.dedupMs) return false; // deduped
      this.lastSent.set(dedupKey, now);
    }
    try {
      await this.fetchFn(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...event, ts: now, source: "llmswitch" }),
        signal: AbortSignal.timeout(5000),
      });
      return true;
    } catch {
      return false; // alerting failure is never fatal
    }
  }
}
