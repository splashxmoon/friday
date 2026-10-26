import { slowly } from "../slow.js";
import type { Redis } from "ioredis";
import { MAIN_LANE, type ActorRef, type EventBody, type Member, type SessionEvent, type SessionOptionsPatch } from "../types.js";
import { sessionKeys } from "./keys.js";
import { hideSecretsIn } from "../secrets.js";
import { endLiveText } from "../bus.js";
import { apply, project, type SessionState } from "./projection.js";
import { fillPatches, internPatches, refPatches } from "./patches.js";
/**
 * The lasting copy of every session's log, when there is one (archive.ts keeps it in Postgres on the hosted service; on
 * someone's own computer there is none): what the store asks of it.
 */
export interface SessionArchive {
  push(sid: string, firstSeq: number, raws: string[]): void;
  flush(): Promise<void>;
  read(sid: string): Promise<string[]>;
  lastSeq(sid: string): Promise<number>;
  drop(sid: string): Promise<void>;
  listed(userId: string, sid: string, at: number, opts: { bump: boolean; show?: boolean }): Promise<void>;
  hide(userId: string, sid: string): Promise<void>;
  mine(userId: string, limit: number): Promise<{ sid: string; at: number }[]>;
  hidden(userId: string): Promise<string[]>;
}

/**
 * Appends one event, atomically with a compare-and-set on the control hash.
 *
 * This script is the only writer of both the log and the control token, so the
 * token can never drift from the log, and a permission decision ("is this
 * person the driver?") and the write it authorises happen in one step. Checking
 * the driver in the gateway and writing later would let a takeover slip in
 * between.
 *
 * `epoch` is bumped by preempting commands (pause, cancel, interrupt). The agent
 * runtime appends with the epoch it started a step under, so a step that was
 * preempted can't commit stale output.
 */
const APPEND_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then return {0, 'gone', '', '0'} end
if string.sub(KEYS[4], -5) == ':must' and redis.call('LLEN', KEYS[1]) == 0 then return {0, 'missing', '', '0'} end
local lane = ARGV[8]
local fDriver, fName, fEpoch = 'driver:' .. lane, 'driverName:' .. lane, 'epoch:' .. lane
local driver = redis.call('HGET', KEYS[2], fDriver) or ''
local epoch = redis.call('HGET', KEYS[2], fEpoch) or '0'
if ARGV[2] ~= '*' and ARGV[2] ~= driver then return {0, 'driver', driver, epoch} end
if ARGV[3] ~= '*' and ARGV[3] ~= epoch then return {0, 'epoch', driver, epoch} end
if ARGV[6] == '1' then epoch = tostring(redis.call('HINCRBY', KEYS[2], fEpoch, 1)) end
if ARGV[4] ~= '*' then
  redis.call('HSET', KEYS[2], fDriver, ARGV[4], fName, ARGV[5])
  driver = ARGV[4]
end
local first = redis.call('LLEN', KEYS[1]) + 1
local seq = first
for i = 8, #ARGV do
  local raw = i == 8 and ARGV[1] or ARGV[i]
  local ev = '{"seq":' .. seq .. ',' .. string.sub(raw, 2)
  redis.call('RPUSH', KEYS[1], ev)
  redis.call('PUBLISH', ARGV[7], '{"kind":"event","event":' .. ev .. '}')
  seq = seq + 1
end
return {first, 'ok', driver, epoch}
`;

/** A session refused because its workspace is being deleted (deleteWorkspace in app.ts): said as a 409. */
export class WorkspaceClosing extends Error {}

export interface AppendGuard {
  /**
   * Which lane's control token this write is guarded by. Every lane has its own
   * driver and epoch in the same control hash, so lanes run independently while
   * still sharing one atomic script and one ordered log.
   */
  lane?: string;
  /** Current driver must equal this id ('' = nobody driving). Omit to skip. */
  expectDriver?: string;
  /** Control epoch must equal this. Omit to skip. */
  expectEpoch?: string;
  /** New driver id ('' = release). Omit to leave unchanged. */
  setDriver?: { id: string; name: string };
  bumpEpoch?: boolean;
  /**
   * The session's first event: a log is started. Any other write to a session Redis has no log for is refused by the script
   * ('missing') until the log is put back from the archive, so a write can never start a new log over a session's history.
   */
  fresh?: boolean;
}

export type AppendResult =
  | { ok: true; seq: number; epoch: string }
  | { ok: false; reason: "driver" | "epoch" | "gone"; driver: string; epoch: string };

/** How long a session found in neither Redis nor the archive is taken to be absent, before the archive is asked again. */
const ABSENT_MS = 30_000;

/**
 * A session's log and its folded state, kept in memory between calls.
 *
 * Every read used to fetch the whole log from Redis and fold it again — on
 * every agent step, every command, every join. A session that has been running
 * for an hour is megabytes, and the work is quadratic in its own history.
 *
 * Redis stays the source of truth: each read asks how long the log is now
 * (one cheap call) and folds only what is new. Nothing here is a second copy
 * of the truth, just the part already read.
 *
 * Over budget, a session's events go before its state does: the events are
 * what is big, and the state is what most reads want (the board, the morning
 * cards, every command). A session kept as state alone still costs one LLEN and
 * a tail read to bring up to date; only events() reads its whole log again.
 */
interface Cached {
  /** Null once dropped to save memory. Past the newest KEEP_WHOLE, long tool output is held trimmed (`trimmed`). */
  events: SessionEvent[] | null;
  /** The seqs whose tool output is held trimmed: read whole from Redis by `asLogged` when somebody is shown them. */
  trimmed: Set<number>;
  /** How far into the events trimming has looked. */
  trimmedTo: number;
  /** How much of the log the state has folded. */
  len: number;
  state: SessionState;
  /** Raw size of the events held, 0 while they are dropped. */
  bytes: number;
  used: number;
}

/**
 * Roughly how much of the process's memory the cache may hold, counted as the
 * raw log's size. Parsed, it takes two or three times that, and the server has
 * 512MB in all.
 */
const DEFAULT_BUDGET = Number(process.env.SESSION_CACHE_BYTES ?? 32 * 1024 * 1024);
// ponytail: a session count, not a size, caps the states; count their bytes if one state can grow large.
const MAX_SESSIONS = 5000;
/**
 * How recently a session must have been read for its events to be kept over budget. Dropping the events of a session in use
 * saves nothing: its next read, a second or two later, takes all of it from Redis again, and holds a second copy while it
 * folds. Edge Defense's log grew past the whole budget on its own (32 MB, 20,000 events), so every read of any other session
 * dropped it, and it was read whole every few seconds until the server ran out of memory twice in three minutes and everyone
 * was shown "Reconnecting…" (Arun, 2026-10-24: "look into why it is disconnecting and reconnecting over and over again").
 */
export const HOT_MS = 2 * 60 * 1000;
/**
 * How many of a session's newest events the cache holds exactly as logged. Older ones hold a tool's output longer than
 * TRIM_OVER as its start and end (trimOutput): tool output was the most of a long session's log (Edge Defense's: 12 of 33 MB,
 * in 4,800 results), and it grew past what the server could hold (Arun, 2026-10-24: "make very long sessions take less memory
 * on the server"). What reads old output on the server takes a few hundred characters of it at most (the decision log, the
 * checks on the agents hub, an agent's context, which clips it anyway); a page shown it gets it whole (`asLogged`), and Redis and
 * the archive keep every event as it was.
 */
export const KEEP_WHOLE = 2000;
const TRIM_OVER = 2000;
const TRIM_HEAD = 600;
const TRIM_TAIL = 1600;

/** A long tool output held in memory: its start and end, and how much of the middle was left out. */
export function trimOutput(output: string): string {
  if (output.length <= TRIM_OVER) return output;
  const held = `${output.slice(0, TRIM_HEAD)}\n\n[…${output.length - TRIM_HEAD - TRIM_TAIL} characters left out of the middle]\n\n${output.slice(-TRIM_TAIL)}`;
  // A string of its own: V8 keeps the parts of one cut from another pointing into the original, which then stays in memory
  // whole, and trimming saved nothing (measured: 24.0 MB held either way for a 21.5 MB log).
  return Buffer.from(held, "utf8").toString("utf8");
}
/**
 * How long a session's log stays in Redis after its last write, when Postgres keeps the lasting copy (archive.ts). Redis is a
 * small cache in production, 25 MB on Render's free plan, full and evicting by 2026-10-13: a session nobody has written to for
 * this long leaves it, and is put back from the archive the moment somebody opens it (restore). Twelve hours, from three days
 * (2026-10-19): one busy session's log filled the 25 MB until Redis restarted, again and again. Without an archive nothing
 * expires, since Redis is then the only copy.
 */
export const IDLE_LOG_MS = 12 * 60 * 60 * 1000;
/** An event as the cache holds it once it is old: a tool's long output trimmed (trimOutput), anything else as it is. */
function trimmedEvent(e: SessionEvent): SessionEvent {
  const b = e.body;
  if (b.type !== "tool.result" || b.output.length <= TRIM_OVER) return e;
  return { ...e, body: { ...b, output: trimOutput(b.output) } };
}

/** How many events a whole log is read in at a time, the server answering everything else between them. */
const READ_BATCH = 1000;
/** How long the mark of how far a log was checked for secrets is kept: longer than any log stays in Redis idle. */
const SHIELDED_MS = 30 * 24 * 60 * 60 * 1000;
/** What closes a lane's stream on the page (useSession streamsAfter), and so its held text (bus.ts). */
const ENDS_STREAM = new Set(["agent.message", "run.ended", "run.pause", "run.cancel"]);

export class SessionStore {
  private cache = new Map<string, Cached>();
  private cachedBytes = 0;

  constructor(
    readonly redis: Redis,
    readonly prefix: string,
    private budget = DEFAULT_BUDGET,
    /** The lasting copy in Postgres (archive.ts), when there is a database. */
    readonly archive: SessionArchive | null = null,
    /** How recently read a session's events are kept over budget (HOT_MS); a test of eviction itself passes 0. */
    private hotMs = HOT_MS,
    /** How many of the newest events are held exactly as logged (KEEP_WHOLE); a test passes a few. */
    private keepWhole = KEEP_WHOLE,
  ) {}

  /** Sessions whose every event is in the archive, so Redis may let theirs go (IDLE_LOG_MS). Learnt as they are proven. */
  private whole = new Set<string>();
  /** Sessions looked for and found nowhere, a moment ago: a link to one that never existed doesn't ask Postgres each time. */
  private absent = new Map<string, number>();
  /** Restores under way, by session: everyone opening it at once shares one. */
  private restoring = new Map<string, Promise<boolean>>();

  /**
   * Put a session's log back into Redis from the archive, when Redis has lost it (evicted, or restarted without persistence).
   * Whole and in one RPUSH, under a lock, so no append lands in the middle (appends to a missing log are refused meanwhile),
   * and with who drives each lane, from the log. Says whether the session is there now.
   */
  restore(sid: string): Promise<boolean> {
    if (!this.archive) return Promise.resolve(false);
    let p = this.restoring.get(sid);
    if (p) return p;
    p = this.restoreNow(sid).finally(() => this.restoring.delete(sid));
    this.restoring.set(sid, p);
    return p;
  }

  private async restoreNow(sid: string): Promise<boolean> {
    const k = this.keys(sid);
    if ((await this.redis.llen(k.events)) > 0) return true;
    if ((this.absent.get(sid) ?? 0) > Date.now() || (await this.buried(sid))) return false;
    const lock = `${k.events}:restoring`;
    if (!(await this.redis.set(lock, "1", "PX", 60_000, "NX"))) {
      // Another process is putting it back: wait for it.
      for (let i = 0; i < 300 && (await this.redis.exists(lock)); i++) await new Promise((r) => setTimeout(r, 100));
      return (await this.redis.llen(k.events)) > 0;
    }
    try {
      if ((await this.redis.llen(k.events)) > 0) return true;
      const raws = await this.archive!.read(sid);
      if (!raws.length) {
        this.absent.set(sid, Date.now() + ABSENT_MS);
        return false;
      }
      // Whole or not at all: a kept log missing its start (events from before the archive, never copied) would be numbered
      // wrong once in Redis, and every seq after it would point at the wrong event.
      const seqs = raws.map((r) => (JSON.parse(r) as { seq: number }).seq);
      if (seqs.some((q, i) => q !== i + 1)) {
        console.error(`[archive] not putting back ${sid}: the kept log runs ${seqs[0]}…${seqs.at(-1)} with gaps (${raws.length} events)`);
        this.absent.set(sid, Date.now() + ABSENT_MS);
        return false;
      }
      // The archive keeps the log as it was written, so the copy put back is checked for secrets again from its start.
      await this.redis.multi().del(k.shielded).rpush(k.events, ...raws).exec();
      const state = project(sid, raws.map((r) => JSON.parse(r) as SessionEvent));
      const drivers: [string, { id: string; name: string } | null][] = [[MAIN_LANE, state.driver], ...Object.entries(state.laneDrivers)];
      for (const [lane, d] of drivers) {
        await this.redis.hsetnx(k.control, `driver:${lane}`, d?.id ?? "");
        await this.redis.hsetnx(k.control, `driverName:${lane}`, d?.name ?? "");
      }
      this.drop(sid);
      this.whole.add(sid);
      console.log(`[archive] put session ${sid} back from Postgres (${raws.length} events)`);
      return true;
    } finally {
      await this.redis.del(lock);
    }
  }

  /**
   * Copy into the archive what Redis holds and the archive doesn't yet: every session's log past what is kept, and everyone's
   * lists. Run at start, so the sessions still in Redis are safe from the moment this ships, and after any time the archive
   * couldn't be written. Returns how many events it copied.
   */
  async backfill(): Promise<number> {
    if (!this.archive) return 0;
    let copied = 0;
    let sessions = 0;
    let seen = 0;
    const started = Date.now();
    console.log(`[archive] copying session history from Redis to Postgres (keys ${this.prefix}{…}:events)`);
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(cursor, "MATCH", `${this.prefix}{*}:events`, "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        const sid = key.slice(this.prefix.length + 1, key.length - "}:events".length);
        if (!sid || (await this.redis.type(key)) !== "list") continue;
        seen++;
        const len = await this.redis.llen(key);
        const kept = await this.archive.lastSeq(sid);
        if (len > kept) {
          for (let from = kept; from < len; from += 1000) {
            const raws = await this.redis.lrange(key, from, Math.min(len, from + 1000) - 1);
            this.archive.push(sid, from + 1, raws);
            copied += raws.length;
          }
          await this.archive.flush();
          sessions++;
        }
        // Proven whole: from here its Redis copy may expire, since all of it comes back from the archive.
        if ((await this.archive.lastSeq(sid)) >= len) this.whole.add(sid);
        if (seen % 50 === 0) console.log(`[archive] … ${seen} sessions looked at, ${copied} events copied so far`);
      }
    } while (cursor !== "0");
    console.log(`[archive] ${seen} sessions in Redis: copied ${copied} events of ${sessions} into Postgres in ${Math.round((Date.now() - started) / 1000)}s`);
    for (const [kind, pattern] of [["mine", `${this.prefix}mine:*`], ["hidden", `${this.prefix}hidden:*`]] as const) {
      cursor = "0";
      do {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
        cursor = next;
        for (const key of keys) {
          const userId = key.slice(pattern.length - 1);
          if (kind === "mine") {
            const raw = await this.redis.zrange(key, "0", "-1", "WITHSCORES");
            for (let i = 0; i + 1 < raw.length; i += 2) await this.archive.listed(userId, raw[i]!, Number(raw[i + 1]), { bump: true });
          } else for (const sid of await this.redis.smembers(key)) await this.archive.hide(userId, sid);
        }
      } while (cursor !== "0");
    }
    return copied;
  }

  /**
   * The log and the state, both current.
   *
   * The length check is what makes this safe across processes: another node
   * appending is seen here as a longer log, and only the new entries are read.
   * A log that got *shorter* (a session deleted and remade under the same id)
   * is folded from scratch.
   */
  private async load(sid: string, withEvents: boolean): Promise<{ events: SessionEvent[] | null; state: SessionState }> {
    const key = this.keys(sid).events;
    let len = await this.redis.llen(key);
    // Redis lost it (evicted, or restarted empty): back from the archive before anything is read.
    if (len === 0 && this.archive && (await this.restore(sid))) len = await this.redis.llen(key);
    // An entry whose events were dropped still answers for the state, not for the events.
    const usable = (c: Cached | undefined): c is Cached => !!c && (!!c.events || !withEvents);
    const hit = this.cache.get(sid);
    if (usable(hit) && hit.len >= len) {
      if (hit.len === len) return this.done(hit);
      // Further along than the length read a moment ago: another read has caught up with events appended since. Only a log that
      // is really shorter now (a session deleted and remade under the same id) is read whole again.
      if ((await this.redis.llen(key)) >= hit.len) return this.done(hit);
    }
    if (usable(hit) && hit.len < len) {
      const from = hit.len;
      const raw = await this.redis.lrange(key, from, -1);
      /**
       * Catching up takes what is there. Events appended between the length and this read came back too, and another read may
       * have applied some of them meanwhile: each of those used to send it to read the whole log again, which in a busy long
       * session (agents logging every step) was every few seconds, 33 MB each time, until the server ran out of memory (Arun,
       * 2026-10-24: "disconnecting and reconnecting over and over again"). Only events that don't follow on from what is held
       * (a log cut and written again) still do.
       */
      if (this.cache.get(sid) === hit && usable(hit) && hit.len >= from && hit.len <= from + raw.length) {
        const rest = raw.slice(hit.len - from);
        const parsed = rest.map((r) => JSON.parse(r) as SessionEvent);
        if (parsed.every((ev, i) => ev.seq === hit.len + 1 + i)) {
          let added = 0;
          parsed.forEach((ev, i) => {
            // A change set's references filled in from the lane's last one, before it becomes the last one (patches.ts).
            fillPatches(ev, hit.state, (q) => hit.events?.[q - 1]);
            hit.events?.push(ev);
            apply(hit.state, ev);
            added += rest[i]!.length;
          });
          hit.len += parsed.length;
          if (hit.events) {
            hit.bytes += added;
            this.cachedBytes += added;
            this.trim(hit);
          }
          return this.done(hit);
        }
      }
    }
    const fresh = await this.loadAll(sid, key);
    // A load already under way when this call looked may have read a log shorter than the one it saw, or another session's
    // read may have dropped its events since: either way, once more, which now finds the entry and reads only what it lacks.
    if (fresh.len < len || (withEvents && !fresh.events)) return this.load(sid, withEvents);
    return this.done(fresh);
  }

  /** Whole-log reads in progress, by session: everyone reconnecting after a restart shares one read and one fold. */
  private loading = new Map<string, Promise<Cached>>();

  /**
   * The last whole-log read queued: one runs at a time, across every session. A whole read holds its session about twice over
   * while it parses and folds; several at once (a restart, everyone reconnecting, a long session among them) were what ran the
   * server out of memory, and the next queued waits seconds at most.
   */
  private wholeTurn: Promise<unknown> = Promise.resolve();

  private loadAll(sid: string, key: string): Promise<Cached> {
    let p = this.loading.get(sid);
    if (p) return p;
    const turn = this.wholeTurn;
    p = turn.catch(() => undefined).then(async () => {
      const shield = this.keys(sid).shielded;
      // In batches, each parsed (and its long old tool output trimmed) before the next is read: the whole log read in one go was
      // every event twice over at once, its raw text and what was parsed from it, 33 MB of text for Edge Defense's.
      const [len, checked] = await Promise.all([this.redis.llen(key), this.redis.get(shield)]);
      const t0 = performance.now();
      // A log written before the secret shield may hold a key: hidden as it is read, so nobody is shown it now either. Once:
      // an event that needed it is written back hidden, and how far the log has been checked is kept, so the next read only
      // looks at what came after. Every event since the shield was hidden as it was written; looking at all 22 MB of a long
      // session again on every read was most of a three-second stall of the whole server (Arun, 2026-10-23).
      // In batches, the server answering everything else between them: a long log read whole is seconds on half a CPU.
      const from = Math.min(Number(checked) || 0, len);
      const shown: SessionEvent[] = [];
      const cleaned: [number, SessionEvent][] = [];
      const trimmed = new Set<number>();
      const keepFrom = len - this.keepWhole;
      let bytes = 0;
      let read = 0;
      for (let i = 0; i < len; i += READ_BATCH) {
        const raw = await this.redis.lrange(key, i, i + READ_BATCH - 1);
        for (let k = 0; k < raw.length; k++) {
          const j = i + k;
          const e = JSON.parse(raw[k]!) as SessionEvent;
          const hidden = j >= from ? hideSecretsIn(e) : e;
          if (hidden !== e) cleaned.push([j, hidden]);
          const held = j < keepFrom ? trimmedEvent(hidden) : hidden;
          if (held !== hidden) trimmed.add(held.seq);
          shown.push(held);
          bytes += raw[k]!.length - (held === hidden ? 0 : (hidden.body as { output: string }).output.length - (held.body as { output: string }).output.length);
        }
        read += raw.length;
        // Shorter than asked: the log was cut (a session deleted and remade) while this read. What was read is folded; the next
        // read sees the length it has now.
        if (raw.length < READ_BATCH) break;
        await new Promise((r) => setImmediate(r));
      }
      const t1 = performance.now();
      if (from < read) {
        const write = this.redis.multi();
        for (const [j, e] of cleaned) write.lset(key, j, JSON.stringify(e));
        write.set(shield, String(read), "PX", SHIELDED_MS);
        await write.exec().catch((e: Error) => console.error(`[store] keeping ${sid} hidden:`, e.message));
        // A session deleted during this read keeps no marker of it. (Plain commands: the local edition's store has no scripts.)
        if (!(await this.redis.exists(key))) await this.redis.del(shield);
      }
      // Each change set's patches as one string however often it was logged, references filled in (patches.ts).
      const found = { repeats: 0 };
      const t2 = performance.now();
      const events = internPatches(shown, found);
      const t3 = performance.now();
      // Stored before patches were kept once: compacted in the background, so the next read is smaller (compact.ts).
      if (found.repeats) this.onRepeats?.(sid);
      const fresh: Cached = { events, len: events.length, state: project(sid, events), bytes, used: Date.now(), trimmed, trimmedTo: Math.max(0, keepFrom) };
      slowly(`reading ${sid} whole`, t0, { events: events.length, mb: Math.round(fresh.bytes / 1048576), trimmed: trimmed.size, read: t1 - t0, checked: read - from, patches: t3 - t2, fold: performance.now() - t3 });
      this.drop(sid);
      this.cache.set(sid, fresh);
      this.cachedBytes += fresh.bytes;
      return fresh;
    }).finally(() => this.loading.delete(sid));
    this.wholeTurn = p.catch(() => undefined);
    this.loading.set(sid, p);
    return p;
  }

  /**
   * The entry just read is never the one evicted: a log bigger than the whole budget used to lose its events the moment
   * they were read, and every events() call then read and parsed all of it again from Redis.
   */
  private done(c: Cached): { events: SessionEvent[] | null; state: SessionState } {
    c.used = Date.now();
    this.evict(c);
    return { events: c.events, state: c.state };
  }

  /** The events that have fallen out of the newest KEEP_WHOLE since the last look: their long tool output held trimmed. */
  private trim(c: Cached): void {
    const events = c.events;
    if (!events) return;
    const until = events.length - this.keepWhole;
    let saved = 0;
    for (let i = c.trimmedTo; i < until; i++) {
      const e = events[i]!;
      const held = trimmedEvent(e);
      if (held === e) continue;
      saved += (e.body as { output: string }).output.length - (held.body as { output: string }).output.length;
      events[i] = held;
      c.trimmed.add(e.seq);
    }
    c.trimmedTo = Math.max(c.trimmedTo, until);
    c.bytes -= saved;
    this.cachedBytes -= saved;
  }

  /**
   * These events as the log has them: any whose tool output the cache holds trimmed are read whole from Redis, so a page
   * scrolling back through a long session sees every command's output in full. One read of the span they cover, per call.
   */
  async asLogged(sid: string, events: SessionEvent[]): Promise<SessionEvent[]> {
    const c = this.cache.get(sid);
    const need = c?.trimmed.size ? events.filter((e) => c.trimmed.has(e.seq)) : [];
    if (!need.length) return events;
    const lo = Math.min(...need.map((e) => e.seq));
    const hi = Math.max(...need.map((e) => e.seq));
    const raw = await this.redis.lrange(this.keys(sid).events, lo - 1, hi - 1);
    const got = new Map<number, SessionEvent>();
    for (const e of need) {
      const r = raw[e.seq - lo];
      if (!r) continue;
      const full = JSON.parse(r) as SessionEvent;
      if (full.seq === e.seq) got.set(e.seq, full);
    }
    return events.map((e) => got.get(e.seq) ?? e);
  }

  private drop(sid: string): void {
    const old = this.cache.get(sid);
    if (!old) return;
    this.cachedBytes -= old.bytes;
    this.cache.delete(sid);
  }

  /**
   * Least recently used first: events go until the cache is back inside its
   * budget, never a session's in use (HOT_MS), and whole entries once there are more than MAX_SESSIONS. Each goes a
   * tenth below its limit, so the sort is paid once in a while and not on every
   * read of a busy session.
   */
  private evict(keep: Cached): void {
    if (this.cachedBytes <= this.budget && this.cache.size <= MAX_SESSIONS) return;
    const byAge = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    if (this.cachedBytes > this.budget) {
      // Over budget on sessions in use (read within HOT_MS), the cache stays over: those are read again at once if dropped.
      const hot = Date.now() - this.hotMs;
      for (const [, c] of byAge) {
        if (this.cachedBytes <= this.budget * 0.9) break;
        if (!c.events || c === keep || c.used > hot) continue;
        this.cachedBytes -= c.bytes;
        c.events = null;
        c.bytes = 0;
      }
    }
    if (this.cache.size > MAX_SESSIONS) for (const [sid] of byAge.slice(0, this.cache.size - Math.floor(MAX_SESSIONS * 0.9))) this.drop(sid);
  }

  /** What the cache is holding, for a deployment that wants to watch it. */
  get cacheStats(): { sessions: number; bytes: number } {
    return { sessions: this.cache.size, bytes: this.cachedBytes };
  }

  keys(sid: string) {
    return sessionKeys(this.prefix, sid);
  }

  /**
   * A session deleted: for a week, nothing more is written to its log. A run still winding down (its last step, its end) or a
   * machine's last word would otherwise start a new log under the old id, and its old links would open it again.
   */
  async bury(sid: string): Promise<void> {
    await this.redis.set(this.keys(sid).gone, "1", "PX", 7 * 24 * 60 * 60 * 1000);
    this.drop(sid);
    // Deleted means deleted: its kept copy goes too, or it would come back once the grave marker expires.
    await this.archive?.drop(sid).catch((e) => console.error("[archive] drop:", (e as Error).message));
  }

  async buried(sid: string): Promise<boolean> {
    return (await this.redis.exists(this.keys(sid).gone)) === 1;
  }

  async exists(sid: string): Promise<boolean> {
    return (await this.redis.exists(this.keys(sid).events)) === 1 || (await this.restore(sid));
  }

  /** Called after a run's end is in the log, with the session and the lane. Set once by whoever owns the store. */
  onRunEnded?: (sid: string, lane: string) => void;
  /** A whole read of a session found change sets storing a patch in full that the lane logged before: it can be compacted. */
  onRepeats?: (sid: string) => void;
  /** Every event this node wrote, once it is in the log: for something that watches all sessions without a socket in each. */
  onAppended?: (sid: string, ev: { seq: number; lane: string; actor: ActorRef; body: EventBody }) => void;

  append(sid: string, actor: ActorRef, body: EventBody, guard: AppendGuard = {}): Promise<AppendResult> {
    return this.appendAll(sid, actor, [body], guard);
  }

  /**
   * Several events in one script call, back to back in the log and under one guard check: all of them are written, or none
   * (a run's start and its delivered instructions, one Redis round trip instead of two). The seq returned is the first one's.
   */
  async appendAll(sid: string, actor: ActorRef, bodies: EventBody[], guard: AppendGuard = {}): Promise<AppendResult> {
    // Keys, tokens and passwords never go into the log, nor to anyone watching it (secrets.ts).
    bodies = bodies.map((b) => hideSecretsIn(b));
    const k = this.keys(sid);
    // Serialise without seq; the script splices seq in as the first field.
    const lane = guard.lane ?? MAIN_LANE;
    // The lane's streamed text goes before its end is in the log, never after: a joiner in between would be shown both.
    if (bodies.some((b) => ENDS_STREAM.has(b.type))) endLiveText(k.bus, lane);
    const ts = Date.now();
    // A change set's patches that are the lane's last ones, unchanged, are written as references to where that text already is
    // (patches.ts): the log keeps each once. The rest of the server is told of the whole one.
    // Up to date first (a change set is written once a turn): a cache that hasn't read the last one would write it out again.
    const last = bodies.some((b) => b.type === "agent.diff") ? (await this.state(sid).catch(() => this.cache.get(sid)?.state))?.diffs[lane] : undefined;
    const stored = bodies.map((b) => (b.type === "agent.diff" && last ? { ...b, files: refPatches(b.files, last) } : b));
    const [json, ...more] = stored.map((body) => JSON.stringify({ ts, actor, body, ...(lane === MAIN_LANE ? {} : { lane }) }));
    // With an archive, a write to a session Redis has no log for is refused until the log is back (see `fresh`).
    const must = !!this.archive && !guard.fresh;
    const res = (await this.redis.eval(
      APPEND_LUA,
      4,
      k.events,
      k.control,
      k.gone,
      `${k.events}:${must ? "must" : "new"}`,
      json,
      guard.expectDriver ?? "*",
      guard.expectEpoch ?? "*",
      guard.setDriver ? guard.setDriver.id : "*",
      guard.setDriver ? guard.setDriver.name : "",
      guard.bumpEpoch ? "1" : "0",
      k.bus,
      lane,
      ...more,
    )) as [number, string, string, string];
    const [seq, status, driver, epoch] = res;
    if (status === "missing") {
      // Put back from the archive, then written: or, never kept anywhere, started as a log, as before there was an archive.
      await this.restore(sid);
      return this.appendAll(sid, actor, bodies, { ...guard, fresh: true });
    }
    if (status === "ok") {
      // The lasting copy, as Redis holds it: seq spliced in front exactly as the script does.
      this.archive?.push(sid, Number(seq), [json, ...more].map((r, i) => `{"seq":${Number(seq) + i},${r!.slice(1)}`));
      // With that copy, the Redis one is let go once the session goes quiet (IDLE_LOG_MS), freeing its space: each write pushes it back.
      // Only a session whose whole log is known to be in the archive (started after it, put back from it, or copied by backfill):
      // one with older events Redis alone holds would come back from the archive as only its tail, numbered wrong.
      if (this.archive && (this.whole.has(sid) || (guard.fresh && Number(seq) === 1)))
        void this.redis.multi().pexpire(k.events, IDLE_LOG_MS).pexpire(k.control, IDLE_LOG_MS).pexpire(k.seen, IDLE_LOG_MS).exec().catch(() => {});
      if (this.archive && guard.fresh && Number(seq) === 1) this.whole.add(sid);
      bodies.forEach((body, i) => {
        // Something that wants to know when an agent has finished, whichever agent and whichever process wrote it down.
        if (body.type === "run.ended") queueMicrotask(() => this.onRunEnded?.(sid, lane));
        if (this.onAppended) queueMicrotask(() => this.onAppended?.(sid, { seq: Number(seq) + i, lane, actor, body }));
      });
      return { ok: true, seq: Number(seq), epoch };
    }
    return { ok: false, reason: status as "driver" | "epoch" | "gone", driver, epoch };
  }

  /**
   * The session's events. Treat the array as read-only: it is the cache's own,
   * and every reader gets the same one.
   */
  async events(sid: string, fromSeq = 1): Promise<SessionEvent[]> {
    const events = (await this.load(sid, true)).events!;
    return fromSeq <= 1 ? events : events.slice(fromSeq - 1);
  }

  /** The folded state. Read-only for the same reason. */
  async state(sid: string): Promise<SessionState> {
    return (await this.load(sid, false)).state;
  }

  async control(sid: string, lane = MAIN_LANE): Promise<{ driver: string; epoch: string }> {
    const h = await this.redis.hgetall(this.keys(sid).control);
    return { driver: h[`driver:${lane}`] ?? "", epoch: h[`epoch:${lane}`] ?? "0" };
  }

  /** The sessions a person is in, newest first: kept as an index, since the log of one session knows nothing of the rest. */
  private mineKey(userId: string) {
    return `${this.prefix}mine:${userId}`;
  }

  /** Sessions a person took off their list: kept off it, on every device, until they open one again. */
  private hiddenKey(userId: string) {
    return `${this.prefix}hidden:${userId}`;
  }

  /** A session a browser already knows about, added to the index without moving it up: how sessions from before the index got there. */
  async remember(userId: string, sid: string): Promise<void> {
    // Another device that still lists it doesn't put back what they removed.
    if (await this.redis.sismember(this.hiddenKey(userId), sid)) return;
    await this.redis.zadd(this.mineKey(userId), "NX", 1, sid);
    void this.archive?.listed(userId, sid, 1, { bump: false }).catch(() => {});
  }

  /** Off their list: the server's, and every browser's at its next look. Opening it again puts it back. */
  async forget(userId: string, sid: string): Promise<void> {
    await Promise.all([this.redis.zrem(this.mineKey(userId), sid), this.redis.sadd(this.hiddenKey(userId), sid), this.archive?.hide(userId, sid).catch(() => {})]);
  }

  async hidden(userId: string): Promise<Set<string>> {
    const [r, a] = await Promise.all([this.redis.smembers(this.hiddenKey(userId)), this.archive?.hidden(userId).catch(() => []) ?? []]);
    return new Set([...r, ...a]);
  }

  /** Their sessions, newest first: Redis's list and the archive's together, so a list Redis lost is still there. */
  async mine(userId: string, limit = 100): Promise<{ sid: string; at: number }[]> {
    const [raw, kept, hidden] = await Promise.all([
      this.redis.zrevrange(this.mineKey(userId), 0, limit - 1, "WITHSCORES"),
      this.archive?.mine(userId, limit).catch(() => []) ?? [],
      this.archive ? this.hidden(userId) : new Set<string>(),
    ]);
    const at = new Map<string, number>();
    for (let i = 0; i + 1 < raw.length; i += 2) at.set(raw[i]!, Number(raw[i + 1]));
    for (const k of kept) if (!hidden.has(k.sid)) at.set(k.sid, Math.max(at.get(k.sid) ?? 0, k.at));
    return [...at.entries()].map(([sid, a]) => ({ sid, at: a })).sort((x, y) => y.at - x.at).slice(0, limit);
  }

  /** Set while a workspace is being deleted: no session is started in it, by anyone or anything, until it is gone. */
  closingKey(workspaceId: string): string {
    return `${this.prefix}ws-closing:${workspaceId}`;
  }

  async create(sid: string, title: string, owner: Member, options: SessionOptionsPatch = {}, workspaceId = ""): Promise<void> {
    // Every way a session starts comes through here (a person, a hook, a schedule, a fork, the sample), so this is the one guard.
    // ponytail: the check, the list entry and the first event are separate round trips, so a create that passes the check a few
    // milliseconds before the mark is set, in a team whose first look finds no session, can outlive the delete. Closing it means
    // checking the mark inside APPEND_LUA for session.created.
    if (workspaceId && (await this.redis.exists(this.closingKey(workspaceId)))) throw new WorkspaceClosing("This team is being deleted.");
    const system: ActorRef = { id: "system", name: "System", kind: "system" };
    await this.redis.zadd(this.mineKey(owner.id), Date.now(), sid);
    void this.archive?.listed(owner.id, sid, Date.now(), { bump: true, show: true }).catch(() => {});
    await this.append(
      sid,
      system,
      { type: "session.created", title, ownerId: owner.id, ownerName: owner.name, ...(workspaceId ? { workspaceId } : {}), options },
      { setDriver: { id: owner.id, name: owner.name }, fresh: true },
    );
  }

  /**
   * Records a member in the log the first time they join, or when their display
   * name changes. `m.role` must already be resolved by the caller (the stored
   * role for existing members, the invite's role for newcomers).
   */
  async ensureMember(sid: string, m: Member, state: SessionState): Promise<void> {
    // Every visit bumps the session to the top of their list, one they had removed included.
    await Promise.all([this.redis.zadd(this.mineKey(m.id), Date.now(), sid), this.redis.srem(this.hiddenKey(m.id), sid), this.archive?.listed(m.id, sid, Date.now(), { bump: true, show: true }).catch(() => {})]);
    const prev = state.members[m.id];
    if (prev && prev.name === m.name && prev.role === m.role) return;
    await this.append(sid, { id: m.id, name: m.name, kind: "human" }, { type: "member.joined", role: m.role });
  }

  async presenceChange(sid: string, userId: string, delta: 1 | -1): Promise<number> {
    const k = this.keys(sid).presence;
    const n = await this.redis.hincrby(k, userId, delta);
    if (n <= 0) await this.redis.hdel(k, userId);
    return Math.max(n, 0);
  }

  async presence(sid: string): Promise<Record<string, number>> {
    const h = await this.redis.hgetall(this.keys(sid).presence);
    return Object.fromEntries(Object.entries(h).map(([id, n]) => [id, Number(n)]));
  }

  async getSeen(sid: string, userId: string): Promise<number> {
    return Number((await this.redis.hget(this.keys(sid).seen, userId)) ?? 0);
  }

  async setSeen(sid: string, userId: string, seq: number): Promise<void> {
    await this.redis.hset(this.keys(sid).seen, userId, String(seq));
  }
}
