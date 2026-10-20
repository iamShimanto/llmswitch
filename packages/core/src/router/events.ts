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

  private listeners = new Set<(e: RoutingEventRecord) => void>();

  subscribe(fn: (e: RoutingEventRecord) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  record(e: Omit<RoutingEventRecord, "ts">): void {
    const rec = { ...e, ts: Date.now() };
    this.buf.push(rec);
    if (this.buf.length > CAP) this.buf.splice(0, this.buf.length - CAP);
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  recent(n = 50): RoutingEventRecord[] {
    return this.buf.slice(-n).reverse();
  }

  clear(): void {
    this.buf = [];
  }
}
