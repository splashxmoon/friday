// Friday stays fast after spec 13 (Wave 4, Arun 2026-11-24: "Go all out and fix these problems"): a change that makes it slower
// fails here, in `npm test`, which the open-source repository's checks run on Linux, macOS and Windows (oss/.github/workflows/ci.yml).
//
// Counts and sizes rather than wall time wherever they say the same thing (elements drawn, bytes sent, memory held after a
// collection), and where time is the point it is compared with a baseline measured in the same run, on the same machine, at the
// same moment: a loaded laptop or a slow CI runner slows both alike. Each failure says what got slower, by how much, and where to
// look. Measured 2026-11-24 (Apple M-series, Node 26): a new event 2-3 ms at 1,000 events and 4.5-5 ms at 20,000 (production
// React); a 20,000-event session's opening message 305 KB (the open-source edition); ready in ~350 ms as a process's first start, fresh or with 120 sessions
// and 30 MB of history, holding 0.3 MB more with the history after a collection.
//
// What needs a browser (an idle Home's fetches and layouts, a long session's long tasks) is checked by the e2e specs
// local-idle-home, local-big-session and local-boot, which log `e2e metric` lines.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/** What the child process (below) measured of the server. */
interface ServerFigures {
  fresh: { readyMs: number; heapMb: number };
  history: { readyMs: number; heapMb: number; sessions: number; mb: number };
  hello: { bytes: number; events: number; diffText: boolean } | null;
}

/**
 * Whether a session's socket can be opened here. This repository's own source signs a socket in with the hosted service's account
 * (app.ts's hello, its `@oss:` line), so only the open-source edition as it ships opens one without a sign-in: its checks measure
 * the opening message here, and in this repository e2e/local-big-session.spec.ts measures it in the browser, on that edition.
 */
const SOCKET = true;

// ── The server, measured in processes of their own ─────────────────────────────────────────────────────────────────────────
//
// Each measured start the first in its process, so the memory it holds is that Friday's alone: not this test runner's or React's,
// and not what an earlier Friday in the same process left behind (closing one and starting another in one process held ~45 MB more,
// which a person's app, one Friday a process, never meets). Homes made up for it, never anyone's data:
//   prime    a long history, started once and closed, as on a computer that has used Friday for a while (the first start on a
//            history from before spec 13 looks over its newest sixty sessions for what was going and keeps the list, app.ts
//            restored; every start after reads the list instead);
//   fresh    an empty home: ready, and the heap after a collection;
//   history  that history: the same, and, where a socket can be opened, a 20,000-event session of four agents and their change
//            sets, whose opening message is read as the page reads it.
const step = process.env.FRIDAY_SPEED_STEP;
if (process.env.FRIDAY_SPEED_CHILD && step) {
  const { setFlagsFromString } = await import("node:v8");
  const { runInNewContext } = await import("node:vm");
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const { synthHome } = await import("./synth-home.js");
  const { seedBigSession } = await import("./big-session.js");
  const { startLocal } = await import("../src/local/start.js");
  const base = process.env.FRIDAY_SPEED_CHILD;
  const start = async (home: string) => {
    const t0 = performance.now();
    const f = await startLocal({ home, port: 0 });
    const readyMs = Math.round(performance.now() - t0);
    // What starting set going in the background (bringing back what was going) done, it has a moment, then is collected.
    await f.restored;
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 0; i < 3; i++) gc();
    return { f, readyMs, heapMb: Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10 };
  };
  let out: unknown = null;
  if (step === "prime") {
    const made = synthHome(path.join(base, "history"), { sessions: 120, mb: 24, bigEvents: 20_000, bigMb: 8 });
    await (await start(made.home)).f.close();
    out = { sessions: made.sessions, mb: made.mb };
  } else if (step === "fresh" || step === "history") {
    const { f, readyMs, heapMb } = await start(path.join(base, step));
    await f.close();
    out = { readyMs, heapMb };
  } else if (step === "hello" && SOCKET) {
    const { default: WebSocket } = await import("ws");
    const home = path.join(base, "big");
    const { sid } = await seedBigSession(home, { events: 20_000 });
    const { f } = await start(home);
    const mine = (await (await fetch(`${f.url}/api/sessions/mine`, { headers: { "x-friday-local": "1" } })).json()) as { sessions: { sid: string; invite: string }[] };
    const invite = mine.sessions.find((s) => s.sid === sid)?.invite;
    if (!invite) throw new Error(`the made-up session isn't in the list: ${JSON.stringify(mine).slice(0, 300)}`);
    // As the page asks for it on opening (useSession.ts socketUrl): the newest 200 events, the rest once those are drawn.
    const text = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${f.url.replace(/^http/, "ws")}/ws?session=${encodeURIComponent(sid)}&invite=${encodeURIComponent(invite)}&tail=200`);
      const timer = setTimeout(() => (ws.terminate(), reject(new Error("no hello in 30 s"))), 30_000);
      ws.on("message", (m) => {
        const s = String(m);
        if (!s.startsWith('{"kind":"hello"')) return;
        clearTimeout(timer);
        ws.close();
        resolve(s);
      });
      ws.on("close", (code, why) => reject(new Error(`the socket closed before its hello: ${code} ${String(why)}`)));
      ws.on("error", (e) => (clearTimeout(timer), reject(e)));
    });
    const hello = JSON.parse(text) as { events: { body: { type: string; files?: { patch?: string }[] } }[]; state: { diffs?: Record<string, { files?: { patch?: string }[] }> } };
    const patches = [...hello.events.flatMap((e) => (e.body.type === "agent.diff" ? (e.body.files ?? []) : [])), ...Object.values(hello.state.diffs ?? {}).flatMap((d) => d.files ?? [])];
    out = { bytes: Buffer.byteLength(text), events: hello.events.length, diffText: patches.some((p) => !!p.patch) };
    await f.close();
  }
  process.stdout.write(`\nSPEED ${JSON.stringify(out)}\n`);
  process.exit(0);
}

const KB = (b: number) => `${Math.round(b / 1024)} KB`;
const times = (a: number, b: number) => `${(a / Math.max(b, 0.01)).toFixed(1)}×`;

test("a new event costs about the same in a 20,000-event session as in a 1,000-event one, and the feed draws only its newest part", async (t) => {
  // As the built app runs: production React, which has no act(), so a draw is flushSync and a tick for its effects
  // (scripts/perf-feed.tsx measures the same way).
  process.env.NODE_ENV = "production";
  (globalThis as Record<string, unknown>).IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  const { container } = await import("./fake-dom.js");
  const { feedLog } = await import("./feed-page.js");
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const { Activity } = await import("../src/client/Activity.js");
  const { project } = await import("../src/session/projection.js");
  const SID = "s-speed";
  const ada = { id: "u1", name: "Ada" };
  type Events = ReturnType<typeof feedLog>;
  const draw = (events: Events, state = project(SID, events)) =>
    React.createElement(Activity, { plan: "pro", connections: [], state, me: { ...ada, role: "owner" }, events, streams: {}, send: async () => ({ ok: true }), sid: SID, invite: "inv", notify: () => {}, identity: ada } as never);
  const render = async (root: ReturnType<typeof createRoot>, el: ReturnType<typeof draw>) => {
    flushSync(() => root.render(el));
    await new Promise((r) => setTimeout(r, 0));
  };
  const nodes = (n: { childNodes: unknown[] }): number => 1 + n.childNodes.reduce<number>((a, c) => a + nodes(c as never), 0);

  const INCOMING = 30;
  const feeds = [1_000, 20_000].map((n) => {
    const el = container();
    return { n, log: feedLog(n + INCOMING), el, root: createRoot(el as never), each: [] as number[], nodes: 0 };
  });
  t.after(() => feeds.forEach((f) => f.root.unmount()));
  for (const f of feeds) {
    await render(f.root, draw(f.log.slice(0, f.n)));
    f.nodes = nodes(f.el as never);
  }
  // One event at a time, as a socket brings them: ten to one feed, then ten to the other, three times over, so whatever else the
  // machine is doing meanwhile slows both alike. (Event by event in turn measured the 20,000-event feed half as fast again: each
  // draw of the other feed between its own left it starting cold.) The state is folded before the clock starts: the page keeps it
  // as events come (useSession), it is not the feed's cost.
  for (let round = 0; round < 3; round++)
    for (const f of feeds)
      for (let i = 1; i <= INCOMING / 3; i++) {
        const next = draw(f.log.slice(0, f.n + round * (INCOMING / 3) + i));
        const t0 = performance.now();
        await render(f.root, next);
        f.each.push(performance.now() - t0);
      }
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const [small, big] = feeds.map((f) => ({ ...f, ms: med(f.each) }));
  t.diagnostic(`feed: each new event ${small!.ms.toFixed(1)} ms at 1,000 events, ${big!.ms.toFixed(1)} ms at 20,000 (${times(big!.ms, small!.ms)}); ${small!.nodes} and ${big!.nodes} elements drawn`);

  // Drawn whole, the 20,000-event feed was 167,000 elements, all drawn again on each event; its newest part is a few hundred.
  assert.ok(
    big!.nodes < 5_000,
    `A 20,000-event feed drew ${big!.nodes.toLocaleString("en")} elements, over its budget of 5,000 (its newest part is a few hundred): it draws far more than that, so every new event redraws all of it. Look at Activity.tsx's FEED_WINDOW and feed-window.ts (test/feed-window.test.ts).`,
  );
  // Some of an event's cost grows with the log (a pass or two over its events, ~0.15 ms a thousand): about 2× at 20,000 against
  // 1,000, idle or with five more copies of this test running.
  // What once worked over the whole log on every event made it 5× (15 ms against 3, before 6573fc43). So 4×, or 3 ms more where
  // the cost at 1,000 is tiny.
  const budget = Math.max(4 * small!.ms, small!.ms + 3);
  assert.ok(
    big!.ms <= budget,
    `A new event costs ${big!.ms.toFixed(1)} ms in a 20,000-event session against ${small!.ms.toFixed(1)} ms in a 1,000-event one (${times(big!.ms, small!.ms)}, budget 4×): something the feed does per event goes over the whole log. Measure with \`npx tsx --import ./test/css.mjs scripts/perf-feed.tsx\` and look at what Activity.tsx works out on each draw (log-memo.ts, the group carry in test/feed-group-carry.test.ts, agent-order.ts).`,
  );
  // And never a long task by itself: 60 ms is fifteen times what it costs on a laptop. Held where the machine is of a laptop's speed
  // (a 1,000-event feed under 10 ms); on one ten times slower, as GitHub's macOS runners are (40 ms at 1,000, 2026-11-25), the 4×
  // budget above is what says the feed grew, and a fixed 60 ms would only say the machine is slow.
  if (small!.ms < 10) assert.ok(big!.ms < 60, `A new event costs ${big!.ms.toFixed(1)} ms in a 20,000-event session, over 60 ms: see scripts/perf-feed.tsx.`);
  else t.diagnostic(`a slow machine (${small!.ms.toFixed(1)} ms at 1,000 events): the 60 ms ceiling is left to the 4× budget`);
});

test("Friday starts on a long history about as fast as on none, holds little more of it in memory, and a 20,000-event session's opening message stays small", { timeout: 120_000 }, (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "friday-speed-"));
  t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Its own home folder too, so nothing in it reads this computer's settings, coding tools or sign-ins.
  const home = path.join(base, "person");
  const env: NodeJS.ProcessEnv = { ...process.env, FRIDAY_SPEED_CHILD: base, HOME: home, USERPROFILE: home, FRIDAY_NO_TELEMETRY: "1", FRIDAY_RELAY: "off", FRIDAY_NO_TOOL_UPDATES: "1", FRIDAY_STATE_DIR: path.join(base, "state") };
  delete env.NODE_ENV;
  delete env.FRIDAY_HOME;
  const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
  const run = <T,>(which: string): T => {
    const r = spawnSync(process.execPath, [tsx, fileURLToPath(import.meta.url)], { env: { ...env, FRIDAY_SPEED_STEP: which }, cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 64 << 20 });
    const line = /^SPEED (.+)$/m.exec(r.stdout ?? "")?.[1];
    assert.ok(line, `The ${which} measurement said nothing (exit ${r.status}${r.signal ? `, ${r.signal}` : ""}):\n${(r.stderr ?? "").slice(-3000)}`);
    return JSON.parse(line!) as T;
  };
  const made = run<{ sessions: number; mb: number }>("prime");
  const m: ServerFigures = { fresh: run("fresh"), history: { ...run<{ readyMs: number; heapMb: number }>("history"), ...made }, hello: run("hello") };
  t.diagnostic(`server: ready in ${m.fresh.readyMs} ms fresh, ${m.history.readyMs} ms with ${m.history.sessions} sessions and ${m.history.mb} MB of history; heap ${m.fresh.heapMb} MB fresh, ${m.history.heapMb} MB with the history`);

  // Memory: what starting on the history holds beyond starting on nothing, after a collection. Reading every log at the start, as
  // Friday did before spec 13, held about twice the history's size (60 MB for this one); now it is the index alone.
  const held = m.history.heapMb - m.fresh.heapMb;
  assert.ok(
    held < 12,
    `Started on ${m.history.mb} MB of history, Friday holds ${held.toFixed(1)} MB more than started on none (${m.history.heapMb} against ${m.fresh.heapMb} MB; budget 12 MB): something reads the sessions' logs as it starts instead of when they are opened. Look at local/kv.ts load() and local/logs.ts (test/local-kv-ondemand.test.ts "starting reads no log"), and at what store.ts and app.ts do before listening.`,
  );
  // Time: against the empty start, measured the same way just before. Reading the logs took ~400 ms for 85 MB; this allows a slow
  // disk a second.
  const extra = m.history.readyMs - m.fresh.readyMs;
  assert.ok(
    m.history.readyMs <= Math.max(3 * m.fresh.readyMs, m.fresh.readyMs + 1000),
    `Ready in ${m.history.readyMs} ms with ${m.history.sessions} sessions of history against ${m.fresh.readyMs} ms with none (${extra} ms more, ${times(m.history.readyMs, m.fresh.readyMs)}; budget 3× or a second): starting waits on something that grows with the history. Look at what startLocal (local/start.ts) and createApp do before listening; restoring agents belongs after it (restored).`,
  );
  // The opening message: the newest 200 events and the state, every change set by name and counts, none of their text.
  if (!m.hello) return void t.diagnostic("a session's opening message: measured by the open-source edition's checks, and here by e2e/local-big-session.spec.ts");
  t.diagnostic(`a 20,000-event session's opening message: ${KB(m.hello.bytes)}, ${m.hello.events} events`);
  assert.equal(m.hello.diffText, false, "A long session's opening message carries a change set's text again: it is fetched as a file is opened (session/patches.ts lightDiffs, app.ts hello).");
  assert.ok(m.hello.events <= 200, `A long session's opening message carries ${m.hello.events} events, more than the newest 200 the page asks for (useSession.ts TAIL, app.ts \`tail\`).`);
  // 305 KB measured (spec 13 took the change sets' text out of it); 340 KB leaves room for what a session's state grows to hold.
  assert.ok(
    m.hello.bytes < 340 * 1024,
    `A 20,000-event session's opening message is ${KB(m.hello.bytes)}, ${KB(m.hello.bytes - 340 * 1024)} over its 340 KB budget: the page waits for all of it before drawing. Look at what app.ts's hello puts in the state and events (lightener, lightDiffs, state.diffs) and what grew in session/projection.ts.`,
  );
});
