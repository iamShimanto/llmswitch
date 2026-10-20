/** In-memory routing explainability log (never stores prompts/bodies/keys). */

export interface RoutingEventRecord {
  ts: number;
  type: "routed" | "provider_failed" | "provider_recovered";
  providerId?: string;
  strategy?: string;
  model?: string;
  latencyMs?: number;
  cached?: boolean;
  kind?: string;
  consecutiveFailures?: number;
}

const CAP = 200;

export class RoutingEventLog {
  private buf: RoutingEventRecord[] = [];

  record(e: Omit<RoutingEventRecord, "ts">): void {
    this.buf.push({ ...e, ts: Date.now() });
    if (this.buf.length > CAP) this.buf.splice(0, this.buf.length - CAP);
  }

  recent(n = 50): RoutingEventRecord[] {
    return this.buf.slice(-n).reverse();
  }

  clear(): void {
    this.buf = [];
  }
}
