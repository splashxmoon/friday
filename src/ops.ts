/**
 * What the server is doing right now, kept in memory for the admin console.
 *
 * Counters are per minute, so "how many in the last five minutes" and "the shape of the last half hour" are the same data.
 * Errors go in a short ring. Gauges are read on demand. Nothing here is written anywhere: a restart starts it over, which is
 * fine for a view of the present, and is why it costs nothing to leave on.
 */

const MINUTE = 60_000;
const KEEP_MINUTES = 90;

export interface ErrorEntry {
  at: number;
  source: string;
  message: string;
}

export interface Snapshot {
  at: number;
  startedAt: number;
  gauges: Record<string, number>;
  /** Per-minute counts for the last `minutes`, oldest first. */
  series: Record<string, number[]>;
  /** Totals over the last 5 minutes, and since start. */
  last5m: Record<string, number>;
  total: Record<string, number>;
  llm: { latencyP50: number; latencyP95: number; models: { model: string; calls: number; tokens: number; lastAt: number }[] };
  errors: ErrorEntry[];
  process: { rssMb: number; heapMb: number; lagMs: number; uptimeS: number };
}

export class Ops {
  readonly startedAt = Date.now();
  private buckets = new Map<string, Map<number, number>>();
  private totals = new Map<string, number>();
  private gauges = new Map<string, () => number | Promise<number>>();
  private errors: ErrorEntry[] = [];
  private latencies: number[] = [];
  private models = new Map<string, { calls: number; tokens: number; lastAt: number }>();
  private lag = 0;

  constructor(private now: () => number = Date.now) {
    // How late a timer that should fire every half second actually is: the plainest sign a process is overloaded.
    let last = this.now();
    const t = setInterval(() => {
      const t2 = this.now();
      this.lag = Math.max(0, t2 - last - 500);
      // Seconds without a turn: every socket on this server went unanswered meanwhile, and a drop of all of them follows one.
      if (this.lag > 3000) console.warn(`[stall] the server was held up for ${(this.lag / 1000).toFixed(1)}s`);
      last = t2;
    }, 500);
    t.unref?.();
  }

  count(name: string, n = 1): void {
    const minute = Math.floor(this.now() / MINUTE);
    const b = this.buckets.get(name) ?? new Map<number, number>();
    b.set(minute, (b.get(minute) ?? 0) + n);
    for (const k of b.keys()) if (k < minute - KEEP_MINUTES) b.delete(k);
    this.buckets.set(name, b);
    this.totals.set(name, (this.totals.get(name) ?? 0) + n);
  }

  gauge(name: string, read: () => number | Promise<number>): void {
    this.gauges.set(name, read);
  }

  error(source: string, message: string): void {
    this.count("errors");
    this.count(`errors.${source}`);
    this.errors.push({ at: this.now(), source, message: message.slice(0, 400) });
    if (this.errors.length > 200) this.errors.shift();
  }

  /** One model call that finished: which model, what it cost in tokens, how long it took. */
  llm(model: string, tokens: number, ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 300) this.latencies.shift();
    const m = this.models.get(model) ?? { calls: 0, tokens: 0, lastAt: 0 };
    m.calls++;
    m.tokens += tokens;
    m.lastAt = this.now();
    this.models.set(model, m);
  }

  sum(name: string, windowMs: number): number {
    const b = this.buckets.get(name);
    if (!b) return 0;
    const from = Math.floor((this.now() - windowMs) / MINUTE);
    let n = 0;
    for (const [k, v] of b) if (k >= from) n += v;
    return n;
  }

  series(name: string, minutes: number): number[] {
    const b = this.buckets.get(name);
    const end = Math.floor(this.now() / MINUTE);
    return Array.from({ length: minutes }, (_, i) => b?.get(end - minutes + 1 + i) ?? 0);
  }

  async snapshot(minutes = 30): Promise<Snapshot> {
    const gauges: Record<string, number> = {};
    await Promise.all(
      [...this.gauges].map(async ([k, read]) => {
        try {
          gauges[k] = Number(await read());
        } catch {
          gauges[k] = -1;
        }
      }),
    );
    const names = [...this.buckets.keys()];
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const at = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0);
    const mem = process.memoryUsage();
    return {
      at: this.now(),
      startedAt: this.startedAt,
      gauges,
      series: Object.fromEntries(names.map((n) => [n, this.series(n, minutes)])),
      last5m: Object.fromEntries(names.map((n) => [n, this.sum(n, 5 * MINUTE)])),
      total: Object.fromEntries(this.totals),
      llm: { latencyP50: at(0.5), latencyP95: at(0.95), models: [...this.models].map(([model, m]) => ({ model, ...m })).sort((a, b) => b.calls - a.calls) },
      errors: [...this.errors].reverse().slice(0, 60),
      process: { rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), lagMs: this.lag, uptimeS: Math.round(process.uptime()) },
    };
  }
}

/** The one the whole server reports to. */
export const ops = new Ops();
