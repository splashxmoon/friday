import type { Redis } from "ioredis";
import type { Bus } from "./bus.js";
import type { Focus } from "./focus.js";
import type { SessionState } from "./session/projection.js";
import type { SessionStore } from "./session/store.js";

/**
 * Teammates who move around, for a mock dataset.
 *
 * Following somebody and seeing who is reading which line need other people who are looking at things, and a dataset made for
 * design work has people but nobody at a keyboard. In a mock (a Redis prefix starting "mock") the people shown as online take
 * turns walking the session: a panel, a file in the tree, a line of a changed file, another agent's chat. Each stays a few seconds
 * in one place, so there is time to follow them, and each is somewhere different.
 *
 * It sends the same messages a real browser would, over the same channel, so what it exercises is the real thing. Never started
 * on anything that is not a mock.
 */

const PANELS = ["tree", "overview", "files", "terminal", "tree", undefined] as const;

/** The first added line of a patch, and how many lines follow it: somewhere in a diff that a reader could plausibly be. */
function linesOf(patch: string): number[] {
  const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(patch);
  if (!m) return [1];
  const start = Number(m[1]);
  const n = Math.max(1, Math.min(12, Number(m[2] ?? 1)));
  return Array.from({ length: n }, (_, i) => start + i);
}

export function placesFor(state: SessionState, who: number, step: number): Focus {
  const lanes = ["main", ...state.lanes.map((l) => l.id)];
  const files = Object.values(state.diffs).flatMap((d) => d.files);
  const k = step + who * 2;
  const panel = PANELS[k % PANELS.length];
  const lane = lanes[(who + Math.floor(k / 3)) % lanes.length]!;
  const f = files.length ? files[(k + who) % files.length]! : null;
  const out: Focus = { lane };
  if (panel) out.panel = panel;
  // A file is what somebody has open in the tree, or what they are reading in a diff in the chat.
  if (f && (panel === "tree" || panel === undefined)) {
    out.path = f.path;
    if (panel === undefined) {
      const rows = linesOf(f.patch);
      out.line = rows[(k * 3 + who) % rows.length]!;
    }
  }
  return out;
}

export function startMockFocus(deps: { redis: Redis; prefix: string; store: SessionStore; bus: Bus; owner?: () => string[] }): () => void {
  const { redis, prefix, store, bus } = deps;
  let sids: string[] = [];
  let found = 0;
  let step = 0;
  let stopped = false;

  const discover = async () => {
    const out: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}{*}:events`, "COUNT", 200);
      cursor = next;
      for (const k of keys) {
        const m = /\{([^}]+)\}:events$/.exec(k);
        if (m) out.push(m[1]!);
      }
    } while (cursor !== "0");
    sids = out;
    found = Date.now();
  };

  const tick = async () => {
    if (stopped) return;
    if (Date.now() - found > 30_000) await discover();
    step++;
    for (const sid of sids) {
      const [state, presence] = await Promise.all([store.state(sid), store.presence(sid)]);
      const people = Object.entries(state.members)
        .filter(([id, m]) => !m.removed && (presence[id] ?? 0) > 0)
        .slice(1, 4);
      for (const [i, [id]] of people.entries()) {
        // Each person moves every seven seconds, offset from the others, and says where they are every tick so a late joiner knows.
        const move = Math.floor((step + i * 3) / 7);
        await bus.publish(sid, { kind: "focus", id, at: placesFor(state, i, move) });
      }
    }
  };

  void discover().catch(() => {});
  const timer = setInterval(() => void tick().catch(() => {}), 2000);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
