import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { LaterTask } from "./later.js";

/** Where tasks for later are kept: a hash per Friday home, beside its other things. */
export class LaterStore {
  constructor(
    private redis: Redis,
    private prefix: string,
  ) {}

  private key = () => `${this.prefix}later`;

  async list(): Promise<LaterTask[]> {
    return (await this.redis.hvals(this.key())).flatMap((r) => {
      try {
        return [JSON.parse(r) as LaterTask];
      } catch {
        return [];
      }
    }).sort((a, b) => a.at - b.at);
  }

  async get(id: string): Promise<LaterTask | null> {
    const raw = await this.redis.hget(this.key(), id);
    try {
      return raw ? (JSON.parse(raw) as LaterTask) : null;
    } catch {
      return null;
    }
  }

  async put(t: LaterTask): Promise<void> {
    await this.redis.hset(this.key(), t.id, JSON.stringify(t));
  }

  async remove(id: string): Promise<void> {
    await this.redis.hdel(this.key(), id);
  }

  /** One at a time per task: Friday is one process on one computer, so a lock in it is what makes read-then-write whole. */
  private locks = new Map<string, Promise<unknown>>();
  private async locked<T>(id: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  /**
   * Changed from what it is NOW, not from what an earlier read saw: `f` gets the task as stored and returns its next form, or null
   * to leave it. Gives back what was written, or null when nothing was (gone, or `f` said no).
   */
  mutate(id: string, f: (t: LaterTask) => LaterTask | null): Promise<LaterTask | null> {
    return this.locked(id, async () => {
      const t = await this.get(id);
      const next = t ? f(t) : null;
      if (!next) return null;
      await this.put(next);
      return next;
    });
  }

  /** Removed, unless it is being started: a start can't be pulled back. Says whether it went. */
  drop(id: string): Promise<boolean> {
    return this.locked(id, async () => {
      const t = await this.get(id);
      if (!t || t.status === "starting") return false;
      await this.redis.hdel(this.key(), id);
      return true;
    });
  }

  /**
   * Taken for starting, once: a task in one of the statuses it may move from (queued; Run now also takes missed and failed ones)
   * becomes "starting", or the call says someone else has it. A clock tick and a Run now can land together.
   */
  claim(id: string, now: number, from: LaterTask["status"][] = ["queued"]): Promise<LaterTask | null> {
    return this.mutate(id, (t) => (from.includes(t.status) ? { ...t, status: "starting", startedAt: now, note: "" } : null));
  }

  async add(owner: { id: string; name: string }, task: Omit<LaterTask, "id" | "ownerId" | "ownerName" | "created" | "status">, now = Date.now()): Promise<LaterTask> {
    const t: LaterTask = { id: randomBytes(5).toString("hex"), ownerId: owner.id, ownerName: owner.name, created: now, status: "queued", ...task };
    await this.put(t);
    return t;
  }

  /** Started chats stay a week (the page takes them into Code's history on its next look), then go. */
  async sweep(now: number): Promise<void> {
    for (const t of await this.list()) {
      if (t.status === "running" && t.startedAt && now - t.startedAt > 7 * 24 * 3600_000) await this.remove(t.id);
    }
  }
}
