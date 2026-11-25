import { randomBytes } from "node:crypto";
import { checkStateOf, fixFirstText } from "./check-state.js";
import { withSpend, DIGEST_HOUR, LOOK_MS, UNSHIPPED_MS, WAITING_MS, dayOf, inQuiet, openAsks, type Notice, GOALS_KEEP, goalsAfter, goalLine, sayText, withChat, type Goal, awayLineFor, awayReport, BATCH_MAX, BATCH_MS, IDLE_MS, tidiesIdle, RETRY_MS, RETRY_WINDOW_MS, STUCK_MS, answerText, bigTask, splitsWork, checksWork, clearReady, withMisses, withReady, type ReadyItem, asksWake, batchText, crossoverOf, enqueue, offerOf, readReply, unfinishedOf, wakesLeft, withNotes, countWake, forYouLines, settleForYou, logged, managerBrief, mayWake, nextQueued, saidLine, stepsUp, wakeFor, wakeText, type Manager, type ManagerThread, type ManagerStore, type Wake, pickThreadTool, type RankedTool } from "./managers.js";
import { ENGINE_MODEL_INFO, MAIN_LANE, type EngineTool, type SessionEvent } from "./types.js";
import type { SessionState } from "./session/projection.js";

/** A lane's run, as projection.ts runOf reads it: the main lane's is the session's own run, the others' are in laneRuns. Reading
 *  laneRuns alone called every running main lane idle (the UI session, 2026-11-25: a thread mid-task listed as idle). */
const runAt = (st: Pick<SessionState, "run" | "laneRuns">, lane: string) => (lane === MAIN_LANE ? (st.run ?? st.laneRuns?.[lane]) : st.laneRuns?.[lane]);
const statusAt = (st: Pick<SessionState, "run" | "laneRuns">, lane: string) => runAt(st, lane)?.status ?? "idle";

/**
 * The project Manager at work (managers.ts holds its record and rules): its own session and lane, woken by what happens in its
 * project's sessions, its replies read back into its log, and the queue started when the project goes quiet. Everything it touches
 * comes in through `Deps`, so the tests run it against a store of their own.
 */

export interface Me {
  id: string;
  name: string;
}

export interface Deps {
  managers: ManagerStore;
  state: (sid: string) => Promise<SessionState | null>;
  events: (sid: string) => Promise<SessionEvent[]>;
  exists: (sid: string) => Promise<boolean>;
  /** A new session of the person's, hidden or not. */
  create: (title: string, me: Me, manager?: string) => Promise<string>;
  /** Kept out of the person's sidebar (a Manager's own session). */
  hide: (sid: string, me: Me) => Promise<void>;
  /** An instruction from the person, as a typed message. */
  instruct: (sid: string, me: Me, text: string) => Promise<void>;
  /** An instruction from Friday on one lane, waking it. */
  tell: (sid: string, lane: string, text: string) => Promise<boolean>;
  startTool: (sid: string, me: Me, p: { tool: EngineTool; cwd: string; model?: string; lane?: string; project: string }) => Promise<{ lane: string }>;
  stop: (sid: string, me: Me, lane: string) => Promise<void>;
  me: () => Promise<Me>;
  /** The person's sessions, newest first. */
  sessions: (me: Me) => Promise<string[]>;
  /** The tool to start a queued task with. */
  toolFor: (me: Me, task: string) => Promise<EngineTool | null>;
  /** The router's ranking of the tools ready here for a task (routing.ts rankTools): with it, pickThreadTool chooses; without, toolFor. */
  ranked?: (me: Me, task: string) => Promise<RankedTool[]>;
  folderKey: (p: string) => string;
  limitHit: (error: string) => boolean;
  /** Friday's Check it on a thread's lane: false when there's nothing to check or proof is off there. */
  check?: (sid: string, lane: string) => Promise<boolean>;
  /** A thread's finished work as a ready card, read from its log (no model). */
  readyOf?: (sid: string, lane: string) => Promise<Omit<ReadyItem, "at"> | null>;
  /**
   * A big task split into parts (spec 14, Run): a session of the person's in its own copy of the project, its hub planned and
   * approved, its parts started. `split: false` when it couldn't be planned and runs as one thread there instead; null when it
   * can't be split here at all (no git, say), so it starts as an ordinary thread.
   */
  split?: (m: Manager, task: string, me: Me, pick?: { tool: EngineTool; model?: string; why: string; set?: true }) => Promise<{ sid: string; split: boolean; parts?: number; why?: string } | null>;
  /** The person's Away, while it's on (teammates.ts away): its check-ins say so, and it decides what it can (spec 14: Away). */
  away?: () => Promise<{ until: number; since: number } | null>;
  /** Whether the person has the session open now: an idle thread in front of them is left alone. */
  viewing?: (sid: string) => Promise<boolean>;
  /** A lane gone for good, with its copy: a split's part once its work is brought together. */
  retire?: (sid: string, lane: string, copy: string | null) => Promise<void>;
  /** Whether a coding tool is near its usage limit (NEAR_LIMIT): what would spend more on it (a stronger model, a split) holds back. */
  nearLimit?: (tool: EngineTool) => Promise<boolean>;
  /** A pull request's state on GitHub (cached a minute app-side), for tidying after a merge. */
  prState?: (sid: string, url: string) => Promise<"open" | "merged" | "closed" | null>;
  /** How often it looks over its project (LOOK_MS). */
  lookMs?: number;
  /** How long a thread is quiet before its tool is stopped (IDLE_MS). */
  idleMs?: number;
  /** How long before an errored thread is asked to try again (RETRY_MS); 0 at once (the tests). */
  retryMs?: number;
  /** A question for the person, or work ready for them: to their phone when they're away from the computer (spec 14, P3). */
  notify?: (m: Manager, n: { kind: "ask"; at: number; text: string; sid?: string } | { kind: "ready"; item: ReadyItem } | { kind: "report"; text: string; sid: string }) => void;
  /** Lessons it learned, into the project's memory every agent there is told. */
  learn?: (m: Manager, lines: string[]) => Promise<void>;
  /** How long wakes are gathered into one (BATCH_MS); 0 sends each at once (the tests). */
  batchMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** What a split's main agent is asked once its parts are together: one look over the whole, in its own copy, nothing committed. */
export const splitReview = (title: string, body: { tasks: number; done: number; why?: string }) =>
  `[Friday] The parts of "${title}" are done and brought together here (${body.done} of ${body.tasks}${body.why ? `; ${body.why}` : ""}). Look over the whole change as one piece: check the parts fit together (names, imports, anything one assumed of another), run the project's checks, fix what doesn't fit, and say in two or three lines where it stands. Don't commit, push or open a pull request: the person ships it.`;

/**
 * The folder a lane works for: the folder itself for a lane in its own copy of it, and for a copy of a copy (a split task's part,
 * made from its session's own copy), the folder that copy was made from.
 */
export const laneFolder = (state: SessionState | null, lane: string): string | null => {
  const e = state?.engines[lane];
  if (!e) return null;
  const f = e.copyOf ?? e.cwd ?? null;
  const from = f && e.copyOf ? Object.values(state!.engines).find((x) => x !== e && x.cwd === f && x.copyOf) : undefined;
  return from?.copyOf ?? f;
};

const TOOL_LABEL: Record<string, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", copilot: "GitHub Copilot", opencode: "OpenCode", pi: "Pi" };

export function managersRun(d: Deps) {
  const now = () => (d.now ? d.now() : Date.now());
  const say = d.log ?? ((m: string) => console.error(m));
  /** When each lane last woke its Manager, by `${managerId}:${sid}:${lane}`. */
  const lastWake = new Map<string, number>();
  /** The model each Manager's lane runs on now, by id. */
  const onModel = new Map<string, string>();
  /** Lanes in a stuck run already told, by `${sid}:${lane}`, with the event seq it was told at. */
  const stuckTold = new Map<string, number>();
  const ownSessions = new Set<string>();

  const forFolder = async (folder: string): Promise<Manager | null> => {
    const key = d.folderKey(folder);
    return (await d.managers.list()).find((m) => m.project.key === key) ?? null;
  };

  /** Its session and lane being made, by Captain id: one at a time, so a message right after it's turned on finds it. */
  const ensuring = new Map<string, Promise<Manager>>();
  /** Its session and lane, made and started when it hasn't one that is still there. */
  const ensure = (m: Manager): Promise<Manager> => {
    const going = ensuring.get(m.id);
    if (going) return going;
    const p = ensureNow(m).finally(() => ensuring.delete(m.id));
    ensuring.set(m.id, p);
    return p;
  };
  const ensureNow = async (m0: Manager): Promise<Manager> => {
    // As it is now: another ensure may have made its session since this record was read.
    let m = (await d.managers.get(m0.id)) ?? m0;
    // Its conversation got long: a fresh session, carrying what it learned and how things stand (its brief), so each wake reads less.
    if (m.rotate && m.sid) {
      await stopIt(m);
      const ctx = m.spend?.context;
      m =
        (await d.managers.update(m.id, (cur) => {
          const { sid: _s, lane: _l, rotate: _r, ...rest } = cur;
          return logged(rest as Manager, { at: now(), kind: "said", text: `Started a fresh session: its conversation was getting long${ctx ? ` (${Math.round(ctx / 1000)}k tokens)` : ""}; kept what it learned and where things stand` });
        })) ?? m;
    }
    const me = await d.me();
    if (m.sid && m.lane && (await d.exists(m.sid))) {
      ownSessions.add(m.sid);
      return m;
    }
    const sid = await d.create(`Captain · ${m.project.name}`, me, m.id);
    ownSessions.add(sid);
    await d.instruct(sid, me, managerBrief(m));
    const { lane } = await d.startTool(sid, me, { tool: m.tool, cwd: m.project.folder, model: m.model, project: m.project.name });
    // Out of the person's list once its first words and its tool are in (an instruction puts a session back on the list).
    await d.hide(sid, me).catch(() => {});
    onModel.set(m.id, m.model);
    return (await d.managers.update(m.id, (cur) => ({ ...cur, sid, lane: lane || MAIN_LANE }))) ?? m;
  };

  /** Its lane stopped (turned off or removed); its session stays for its history. */
  const stopIt = async (m: Manager) => {
    if (!m.sid || !m.lane) return;
    const me = await d.me();
    await d.stop(m.sid, me, m.lane).catch(() => {});
    onModel.delete(m.id);
  };

  /** Its lane on the model this wake needs: the step-up one for a hard thing, its everyday one otherwise. */
  const modelFor = async (m: Manager, w: Wake): Promise<Manager> => {
    // Near its tool's usage limit, it stays on its everyday model: a stronger one would spend the rest faster.
    const tight = m.stepUp && stepsUp(m, w, now()) && d.nearLimit ? await d.nearLimit(m.tool).catch(() => false) : false;
    const want = m.stepUp && stepsUp(m, w, now()) && !tight ? m.stepUp : m.model;
    const had = onModel.get(m.id) ?? m.model;
    if (want === had || !m.sid || !m.lane) return m;
    const me = await d.me();
    await d.startTool(m.sid, me, { tool: m.tool, cwd: m.project.folder, model: want, lane: m.lane, project: m.project.name });
    onModel.set(m.id, want);
    const up = !!m.stepUp && want === m.stepUp;
    return (await d.managers.update(m.id, (cur) => logged({ ...cur, ...(up ? { steppedUntil: now() + 15 * 60_000 } : {}) }, { at: now(), kind: "stepped-up", text: up ? `Stepped up to ${want} for a hard one` : `Back on ${want}` }))) ?? m;
  };

  /** Wakes gathered for each Captain, sent together after BATCH_MS so several things cost one turn. */
  const pending = new Map<string, Wake[]>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const batchMs = d.batchMs ?? BATCH_MS;
  const nameOf = (st: SessionState | null, lane: string) => {
    const tool = st?.engines[lane]?.tool;
    return st?.lanes.find((l) => l.id === lane)?.name ?? (tool ? (TOOL_LABEL[tool] ?? tool) : lane === MAIN_LANE ? "The main agent" : lane);
  };
  const wokeWords = (w: Wake, laneName: string, title: string) =>
    `${w.kind === "question" ? `${laneName} asked a question` : w.kind === "circles" ? `${laneName} was going in circles` : w.kind === "stuck" ? `${laneName} had nothing new for a while` : w.kind === "offer" ? `${laneName} stopped to ask leave to go on` : w.kind === "unfinished" ? `${laneName} stopped with its plan unfinished` : w.kind === "crossover" ? `${laneName} changed files another thread is on` : `${laneName} stopped with an error`} in "${title.slice(0, 60)}"`;

  /** Everything gathered for one Captain, sent as one wake (at most BATCH_MAX; the rest go next). */
  const flush = async (id: string): Promise<"sent" | "skipped" | "failed"> => {
    timers.delete(id);
    const all = pending.get(id) ?? [];
    pending.delete(id);
    if (!all.length) return "skipped";
    const items = all.slice(0, BATCH_MAX);
    if (all.length > BATCH_MAX) {
      pending.set(id, all.slice(BATCH_MAX));
      timers.set(id, setTimeout(() => void flush(id), Math.max(batchMs, 1)));
    }
    const m = await d.managers.get(id);
    if (!m?.on) return "skipped";
    if (wakesLeft(m, now()) <= 0) {
      await d.managers.update(id, (cur) => logged(cur, { at: now(), kind: "skipped", text: "Out of today's budget" }));
      return "skipped";
    }
    try {
      let cur = await ensure(m);
      cur = await modelFor(cur, { hard: items.some((w) => w.hard) } as Wake);
      const parts: string[] = [];
      const woke: { text: string; sid: string; lane: string }[] = [];
      for (const w of items) {
        const st = await d.state(w.sid);
        const laneName = nameOf(st, w.lane);
        const title = st?.title ?? "a session";
        const tool = st?.engines[w.lane]?.tool;
        const other = w.other ? await d.state(w.other.sid) : null;
        parts.push(wakeText(w, { title, laneName, ...(tool ? { tool } : {}), ...(other ? { otherTitle: other.title, otherLane: nameOf(other, w.other!.lane) } : {}) }));
        woke.push({ text: wokeWords(w, laneName, title), sid: w.sid, lane: w.lane });
      }
      const away = d.away ? await d.away().catch(() => null) : null;
      const ok = await d.tell(cur.sid!, cur.lane!, batchText(parts, cur, away && away.until > now() ? away.until : undefined));
      if (!ok) return "failed";
      await d.managers.update(id, (x) => woke.reduce((acc, a) => logged(acc, { at: now(), kind: "woke", ...a }), countWake(x, now())));
      return "sent";
    } catch (e) {
      say(`[managers] ${m.project.name}: couldn't wake it: ${(e as Error).message}`);
      await d.managers.update(id, (x) => logged(x, { at: now(), kind: "skipped", text: `Couldn't start: ${(e as Error).message}`.slice(0, 200) }));
      return "failed";
    }
  };

  /** A wake for it, if its rules allow one now: gathered with others and sent together. What happened, for the tests. */
  const wake = async (m: Manager, w: Wake): Promise<"sent" | "queued" | "skipped" | "failed"> => {
    const key = `${m.id}:${w.sid}:${w.lane}`;
    // A thread you're looking at right now: its question, its offer to go on, its unfinished plan are in front of you, so the
    // Captain spends nothing on them (2026-11-25: "optimized for cost"). Stuck, circling, errors and crossovers still wake it.
    if ((w.kind === "question" || w.kind === "offer" || w.kind === "unfinished") && d.viewing && (await d.viewing(w.sid).catch(() => false))) return "skipped";
    const may = mayWake(m, lastWake.get(key), now());
    if (!may.ok) {
      // Said once per thread and reason, not on every event.
      if (may.why !== "off" && may.why !== "Just looked at this thread") {
        const seen = m.log.find((a) => a.kind === "skipped" && a.sid === w.sid && a.lane === w.lane && a.text === may.why && now() - a.at < 60 * 60_000);
        if (!seen) await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "skipped", text: may.why, sid: w.sid, lane: w.lane }));
      }
      return "skipped";
    }
    lastWake.set(key, now());
    const list = pending.get(m.id) ?? [];
    if (!list.some((x) => x.sid === w.sid && x.lane === w.lane && x.kind === w.kind)) list.push(w);
    pending.set(m.id, list);
    if (batchMs <= 0) return flush(m.id);
    if (!timers.has(m.id)) {
      const t = setTimeout(() => void flush(m.id), batchMs);
      (t as { unref?: () => void }).unref?.();
      timers.set(m.id, t);
    }
    return "queued";
  };

  /** How many lanes are running in a Manager's project, across the person's sessions. */
  const runningIn = async (m: Manager, me: Me): Promise<number> => {
    let n = 0;
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || sid === m.sid) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      for (const lane of Object.keys(st.engines)) {
        if (statusAt(st, lane) !== "running") continue;
        const f = laneFolder(st, lane);
        if (f && d.folderKey(f) === m.project.key) n++;
      }
    }
    return n;
  };

  /** A goal's task started: its thread is the goal's now, running. */
  const attachToGoal = async (m: Manager, task: { goal?: string; text: string }, sid: string) =>
    d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === task.goal);
      if (!g) return null;
      return goalsAfter({ ...cur, goals: cur.goals!.map((x) => (x.id === g.id ? { ...x, threads: [...x.threads, { sid, task: task.text.slice(0, 200), state: "running" as const }] } : x)) }, null, null).m;
    });
  /** The tool (and model) a thread it starts runs on, and why: pickThreadTool over the router's ranking, with the project's threads. */
  const choose = async (m: Manager, text: string, me: Me): Promise<{ tool: EngineTool; model?: string; why: string; set?: true } | null> => {
    if (d.ranked) {
      const ranked = await d.ranked(me, text).catch(() => [] as RankedTool[]);
      const threads = (await threadsOf([m], me).catch(() => new Map<string, ManagerThread[]>())).get(m.id) ?? [];
      return pickThreadTool(ranked, { ...m, threads }, text);
    }
    const t = await d.toolFor(me, text).catch(() => null);
    return t ? { tool: t, why: "" } : null;
  };
  /** The next queued task started in a session of its own, when its rules allow; the session's id, or null. */
  const startQueued = async (m: Manager): Promise<string | null> => {
    const me = await d.me();
    const running = await runningIn(m, me);
    const task = nextQueued(m, running, now());
    if (!task) return null;
    // Taken off first, under its lock, so two ends at once never start it twice.
    let took = false;
    await d.managers.update(m.id, (cur) => {
      if (cur.queue[0]?.id !== task.id) return null;
      took = true;
      return { ...cur, queue: cur.queue.slice(1) };
    });
    if (!took) return null;
    // Big, on Run with splitting on: parts at once, each in its own copy, brought together for you.
    // Near the limit of the tool it would run on, a big task isn't split: parts at once spend it several times as fast.
    const pick = await choose(m, task.text, me);
    const busy = d.nearLimit && pick ? await Promise.resolve(d.nearLimit(pick.tool)).catch(() => false) : false;
    if (splitsWork(m) && d.split && bigTask(task.text) && !busy) {
      const r = await d.split(m, task.text, me, pick ?? undefined).catch((e: Error) => (say(`[managers] split: ${e.message}`), null));
      if (r) {
        if (task.goal) await attachToGoal(m, task, r.sid);
        const what = task.text.slice(0, 80);
        await d.managers.update(m.id, (cur) =>
          logged(cur, { at: now(), kind: "started", text: r.split ? `Split "${what}" into ${r.parts ?? "its"} parts` : `Started "${what}" as one thread (couldn't split it: ${(r.why ?? "no plan").slice(0, 120)})`, sid: r.sid }),
        );
        return r.sid;
      }
    }
    const tool = pick?.tool;
    if (!tool) {
      await d.managers.update(m.id, (cur) => logged({ ...cur, queue: [task, ...cur.queue] }, { at: now(), kind: "skipped", text: "No coding tool is ready to start the next task" }));
      return null;
    }
    const sid = await d.create(task.text.split("\n")[0]!.slice(0, 80), me);
    await d.instruct(sid, me, task.text);
    await d.startTool(sid, me, { tool, cwd: m.project.folder, project: m.project.name, ...(pick?.model ? { model: pick.model } : {}) });
    // Which tool and why, said where you read what it did (2026-11-25: "what agents it will select for use").
    await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "started", text: `Started "${task.text.slice(0, 80)}" from the queue on ${TOOL_LABEL[tool] ?? tool}${pick?.why ? `: ${pick.why}` : ""}`, sid }));
    if (task.goal) await attachToGoal(m, task, sid);
    return sid;
  };

  /** Its reply after a wake, read back: what it said, and anything it leaves to the person. */
  const heardReply = async (m: Manager, sid: string, lane: string) => {
    const evs = await d.events(sid);
    const start = evs.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
    const said = evs.filter((e) => e.seq > start && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent").map((e) => (e.body as { text?: string }).text ?? "").join("\n").trim();
    if (!said) return;
    const r = readReply(said);
    const line = saidLine(said) || r.said;
    let queued = false;
    const asked: { at: number; text: string; sid?: string }[] = [];
    // A reply to the person's own message: what it says after their message goes to their conversation, and on Run, work they asked
    // for is a goal. Its turn can carry what it said before their message came (its first, say), which isn't their reply; and a turn
    // that ended before it got to their message leaves it still waiting for one.
    let toYou = replying.get(m.id);
    let reply = r;
    if (toYou) {
      const asked = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "instruction" && /^\[Captain message\]/.test((e.body as { text?: string }).text ?? ""));
      // What it said once it had the message: from the turn it started (run.started caused by it), or from when it was handed into a
      // turn under way (instructions.delivered). A turn going when it came ends with words of its own first.
      const began = asked
        ? evs.find((e) => e.seq > asked.seq && (e.lane ?? MAIN_LANE) === lane && ((e.body.type === "run.started" && e.body.causedBy === asked.seq) || (e.body.type === "instructions.delivered" && e.body.seqs.includes(asked.seq))))
        : undefined;
      const after = began ? evs.filter((e) => e.seq > began.seq && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent").map((e) => (e.body as { text?: string }).text ?? "").join("\n").trim() : "";
      const marked = readReply(after || said);
      if (marked.reply) {
        reply = { ...readReply(after || said), prose: marked.reply };
        replying.delete(m.id);
      } else if (after) {
        reply = readReply(after);
        replying.delete(m.id);
      } else toYou = undefined;
    }
    await d.managers.update(m.id, (cur) => {
      asked.length = 0;
      let next = cur;
      let goal: string | undefined;
      if (toYou) {
        next = withChat(next, "captain", reply.prose || saidLine(reply.prose) || "Done.", now());
        if (reply.goal && cur.level === "run" && reply.queue.length) {
          goal = `g_${randomBytes(4).toString("hex")}`;
          const g: Goal = { id: goal, title: reply.goal, ask: toYou.text, at: now(), status: "working", threads: [] };
          next = logged({ ...next, goals: [g, ...(next.goals ?? [])].slice(0, GOALS_KEEP) }, { at: now(), kind: "said", text: `Goal: ${reply.goal} (${reply.queue.length} task${reply.queue.length === 1 ? "" : "s"})` });
        }
      }
      // The thread it was last woken about: what its questions are about.
      const about = cur.log.find((a) => a.kind === "woke")?.sid;
      if (line) next = logged(next, { at: now(), kind: "said", text: line });
      // What it decided for the person while they're away, and why: on their "While you were away".
      r.assumed.forEach((x, i) => (next = logged(next, { at: now() + i, kind: "assumed", text: x, ...(about ? { sid: about } : {}) })));
      r.forYou.forEach((q, i) => {
        asked.push({ at: now() + i, text: q, ...(about ? { sid: about } : {}) });
        next = logged(next, { at: now() + i, kind: "for-you", text: q, ...(about ? { sid: about } : {}) });
      });
      // Follow-ups it queues go in its queue on Run with queued starts on; otherwise they're suggestions for the person. A goal's
      // tasks are queued on Run whatever the switch says: they're the goal's plan, started once queued starts are on.
      const mayQueue = cur.level === "run" && (cur.startQueued || !!goal);
      const suggest = [...r.next, ...(mayQueue ? [] : r.queue)];
      if (mayQueue)
        for (const q of r.queue) {
          if (next.queue.some((t) => t.text.toLowerCase() === q.toLowerCase())) continue;
          const added = enqueue(next, q, now(), goal);
          if (typeof added !== "string") (next = logged(added, { at: now(), kind: "said", text: `Queued: ${q.slice(0, 120)}` })), (queued = true);
        }
      if (r.learned.length || suggest.length) next = withNotes(next, r.learned, suggest, now());
      return next === cur ? null : next;
    });
    for (const a of asked) d.notify?.(m, { kind: "ask", ...a });
    if (r.learned.length && d.learn) await d.learn(m, r.learned).catch((e: Error) => say(`[managers] learn: ${e.message}`));
    // Queued with the project quiet: it can start now.
    if (queued) {
      const fresh = await d.managers.get(m.id);
      if (fresh) await startQueued(fresh).catch(() => null);
    }
  };

  /** Its own turn now answers a message of the person's: what they said, by Captain id. */
  const replying = new Map<string, { text: string; at: number }>();
  /**
   * The person speaks to it (Arun, 2026-11-25: "talk to it"): their words in its conversation, and to its lane with what it may do
   * at its level. Like an answer, it goes even in quiet hours or past its budget: the person asked.
   */
  const sayTo = async (m: Manager, text: string): Promise<boolean> => {
    const t = text.trim().slice(0, 4000);
    if (!t) return false;
    const next = await d.managers.update(m.id, (cur) => withChat(cur, "you", t, now()));
    const cur = await ensure(next ?? m);
    replying.set(m.id, { text: t, at: now() });
    return d.tell(cur.sid!, cur.lane!, sayText(cur, t));
  };
  /** A goal given up by the person: its queued tasks go; its threads are left as they are. */
  const cancelGoal = async (m: Manager, id: string): Promise<boolean> =>
    !!(await d.managers.update(m.id, (cur) => {
      const g = cur.goals?.find((x) => x.id === id);
      if (!g || g.status === "cancelled" || g.status === "done") return null;
      return logged({ ...cur, queue: cur.queue.filter((q) => q.goal !== id), goals: cur.goals!.map((x) => (x.id === id ? { ...x, status: "cancelled" as const } : x)) }, { at: now(), kind: "said", text: `Goal given up: ${g.title}` });
    }));
  /** A goal's thread moved on (started, ready, shipped, stuck): its goal's status follows, and a goal now ready, done or stuck is said. */
  const goalMoved = async (m: Manager, sid: string, state: Goal["threads"][number]["state"]) => {
    let changed: Goal[] = [];
    await d.managers.update(m.id, (cur) => {
      if (!cur.goals?.some((g) => g.threads.some((t) => t.sid === sid))) return null;
      const r = goalsAfter(cur, sid, state);
      changed = r.changed;
      return changed.reduce((acc, g) => logged(acc, { at: now(), kind: "said", text: `Goal ${g.status === "ready" ? "ready to ship" : g.status}: ${g.title} (${goalLine(g)})`, sid }), r.m);
    });
    for (const g of changed) if (g.status === "ready" || g.status === "stuck" || g.status === "done") d.notify?.(m, { kind: "report", text: `${g.status === "ready" ? "Ready to ship" : g.status === "done" ? "Shipped" : "Stuck"}: ${g.title} · ${goalLine(g)}`, sid });
  };

  /**
   * The person's answer to one of its questions (or "put away" with none): kept on that question, and, answered, told to the
   * Manager to pass on to the thread it's about, even in quiet hours or past its budget: the person asked for it.
   */
  const answer = async (m: Manager, at: number, text: string | null): Promise<"told" | "dismissed" | "gone"> => {
    let q: { text: string; sid?: string } | null = null;
    const next = await d.managers.update(m.id, (cur) => {
      const was = cur.log.find((a) => a.kind === "for-you" && a.at === at);
      const settled = settleForYou(cur, at, text);
      if (!settled || !was) return null;
      q = { text: was.text, ...(was.sid ? { sid: was.sid } : {}) };
      return text ? logged(settled, { at: now(), kind: "said", text: `You answered: ${text.slice(0, 160)}` }) : settled;
    });
    if (!next || !q) return "gone";
    if (!text) return "dismissed";
    const question = q as { text: string; sid?: string };
    const cur = await ensure(next);
    await d.tell(cur.sid!, cur.lane!, answerText(question.text, text, question.sid));
    return "told";
  };

  /** A ready card looked at, shipped or put away. */
  const doneReady = async (m: Manager, sid: string, lane?: string) => !!(await d.managers.update(m.id, (cur) => clearReady(cur, sid, lane)));

  /** A finished turn that stopped short: asking leave to go on, or with its plan unfinished. Nothing on Watch. */
  const turnEnd = async (m: Manager, sid: string, lane: string, st: SessionState | null): Promise<Wake | null> => {
    if (!m.on || m.level === "watch") return null;
    const evs = await d.events(sid);
    const start = evs.findLast((e) => e.body.type === "run.started" && (e.lane ?? MAIN_LANE) === lane)?.seq ?? 0;
    const last = evs.findLast((e) => e.seq > start && (e.lane ?? MAIN_LANE) === lane && e.body.type === "agent.message" && e.actor.kind === "agent");
    const offer = last ? offerOf((last.body as { text?: string }).text ?? "") : null;
    if (offer) return { kind: "offer", sid, lane, detail: offer, hard: false };
    const left = unfinishedOf(st?.planDone?.[lane]);
    return left ? { kind: "unfinished", sid, lane, detail: left, hard: false } : null;
  };

  /** Runs whose end was checked or whose check was read, once each: `${sid}:${lane}:${endSeq}` (and `…:read`). */
  const checkedRuns = new Set<string>();
  /** A finished turn with changes, on Run: Friday's Check it, run by itself. */
  const checkEnd = async (m: Manager, sid: string, lane: string, endSeq: number, st: SessionState | null) => {
    if (!checksWork(m) || !d.check || !st?.diffs?.[lane]?.files.length) return;
    const k = `${sid}:${lane}:${endSeq}`;
    if (checkedRuns.has(k)) return;
    checkedRuns.add(k);
    await d.check(sid, lane).catch((e: Error) => say(`[managers] check: ${e.message}`));
  };
  /**
   * A check's result on a thread's run (whoever asked for it): passed, or nothing to run, and the work is ready for the person; a
   * failure goes back to the thread with what failed, once; failing again, it's the person's (spec 14, scenario 15).
   */
  const checkRead = async (m: Manager, sid: string, lane: string, at: number, st: SessionState | null) => {
    if (!checksWork(m)) return;
    const evs = await d.events(sid);
    // A split's end (hub.ended, on the session's main lane) counts as the end of its work, as a run's does.
    const end = evs.findLast((e) => e.seq < at && (e.lane ?? MAIN_LANE) === lane && (e.body.type === "run.ended" || e.body.type === "hub.ended"));
    if (!end) return;
    const cs = checkStateOf(evs, lane, end.seq);
    if (cs.phase === "none" || cs.phase === "checking") return;
    const k = `${sid}:${lane}:${end.seq}:read`;
    if (checkedRuns.has(k)) return;
    checkedRuns.add(k);
    const title = st?.title || "a thread";
    const key = `${sid}:${lane}`;
    if (cs.phase === "failed") {
      const misses = (m.misses?.[key] ?? 0) + 1;
      if (misses === 1) {
        await d.tell(sid, lane, fixFirstText(cs));
        await d.managers.update(m.id, (cur) => logged(withMisses(clearReady(cur, sid, lane) ?? cur, key, 1), { at: now(), kind: "sent-back", text: `Sent "${title}" its failing check to fix${cs.first ? `: ${cs.first}` : ""}`, sid, lane }));
      } else {
        const at = now();
        const text = `"${title}" still fails its check after a fix${cs.first ? ` (${cs.first})` : ""}. Look at it, or tell it what to try.`;
        await d.managers.update(m.id, (cur) => logged(withMisses(cur, key, misses), { at, kind: "for-you", text, sid, lane }));
        d.notify?.(m, { kind: "ask", at, text, sid });
        await goalMoved(m, sid, "stuck");
      }
      return;
    }
    const item = d.readyOf ? await d.readyOf(sid, lane).catch(() => null) : null;
    await d.managers.update(m.id, (cur) => {
      let next = withMisses(item ? withReady(cur, { ...item, at: now() }) : cur, key, 0);
      // Its question about this thread's failing check is answered by the pass.
      for (const a of cur.log) if (a.kind === "for-you" && a.sid === sid && a.lane === lane && !a.answered && !a.dismissed && /still fails its check/.test(a.text)) next = settleForYou(next, a.at, null) ?? next;
      return logged(next, { at: now(), kind: "checked", text: cs.phase === "passed" ? `"${title}" is ready: its check passes` : `"${title}" is ready: there was no check to run`, sid, lane });
    });
    if (item) d.notify?.(m, { kind: "ready", item: { ...item, at: now() } });
    await goalMoved(m, sid, "ready");
  };

  /** Threads whose merge was tidied after, by sid. */
  const mergedTold = new Set<string>();
  /** Each stuck run's rung on the ladder, by `${sid}:${lane}`: which run (its run.started seq) and how far up. */
  const ladder = new Map<string, { run: number; rung: number }>();
  /**
   * A thread stuck again, the Help ladder (Arun, 2026-11-25; spec 14: "a hint, then… a stronger model, then you"): first a hint from
   * the Captain; still stuck in the same run, its tool started again on its strongest model, the conversation kept, told to carry on
   * with a fresh look (no Captain turn); still stuck, it's yours, with the thread's Pass on to hand it to another tool.
   */
  const stuckRung = async (m: Manager, sid: string, lane: string, st: SessionState, evs: readonly SessionEvent[], me: Me) => {
    const run = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane && e.body.type === "run.started")?.seq ?? 0;
    const k = `${sid}:${lane}`;
    const had = ladder.get(k);
    let rung = had && had.run === run ? had.rung + 1 : 1;
    const e = st.engines[lane];
    const title = st.title || "a thread";
    const name = e?.tool ? (TOOL_LABEL[e.tool] ?? e.tool) : "Its agent";
    // Its tool's strongest model: the first it lists that isn't Friday's Auto.
    const top = e?.tool ? ENGINE_MODEL_INFO[e.tool]?.find((x) => x.id !== "auto")?.id : undefined;
    // Near that tool's usage limit, no stronger model: it would spend the rest faster. Straight to the person.
    const tight = rung === 2 && e?.tool && d.nearLimit ? await d.nearLimit(e.tool).catch(() => false) : false;
    if (rung === 2 && (!e?.tool || !top || e.model === top || tight)) rung = 3;
    ladder.set(k, { run, rung });
    if (rung === 1) return void (await wake(m, { kind: "stuck", sid, lane, detail: "", hard: false }));
    if (rung === 2) {
      await d.startTool(sid, me, { tool: e!.tool!, cwd: e!.cwd, model: top!, lane, project: m.project.name });
      await d.tell(sid, lane, `[Friday] You've made no progress for a while, even after a hint, so you're on a stronger model now. Carry on from where you were with a fresh look: re-read the last error or output, question what you assumed, and try a different approach if the last one isn't working.`);
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "stepped-up", text: `Put ${name} in "${title}" on ${ENGINE_MODEL_INFO[e!.tool!].find((x) => x.id === top)?.label ?? top}: still stuck after a hint`, sid, lane }));
      return;
    }
    if (rung === 3) {
      const text = `"${title}" is still stuck after a hint${had?.rung === 2 ? " and a stronger model" : tight ? ` (${name} is near its usage limit, so no stronger model)` : ""}. Look at it, tell it what to try, or hand it to another coding tool with Pass on.`;
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "for-you", text, sid, lane }));
      d.notify?.(m, { kind: "ask", at: now(), text, sid });
      await goalMoved(m, sid, "stuck");
    }
  };
  /** Threads asked to try again after an error, when: once per RETRY_WINDOW_MS each, by `${sid}:${lane}`. */
  const retried = new Map<string, number>();
  const setTimeoutFn = (fn: () => void, ms: number) => (ms <= 0 ? fn() : void (setTimeout(fn, ms) as { unref?: () => void }).unref?.());
  /** Splits whose parts are together and whose main agent is looking them over. */
  const reviewing = new Set<string>();
  /** A lane that is one of a split task's parts. */
  const isPart = (st: SessionState | null, lane: string) => !!st?.hub && Object.values(st.hub.runs).some((r) => r.lane === lane);
  /**
   * A split task's end. Brought together: checked (on Run with checks on) or straight to a ready card; nothing got through: why,
   * for you. Its parts' own misses are on its card in the thread.
   */
  const splitEnded = async (m: Manager, sid: string, body: { outcome: string; why?: string; tasks: number; done: number }, st: SessionState | null) => {
    const title = st?.title || "a big task";
    if (body.outcome === "cancelled") return;
    if (body.outcome !== "done" || !body.done) {
      const text = `Couldn't get "${title}" done in parts${body.why ? `: ${body.why}` : ""}. Look at it, or tell it what to try.`;
      await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "for-you", text, sid, lane: MAIN_LANE }));
      d.notify?.(m, { kind: "ask", at: now(), text, sid });
      await goalMoved(m, sid, "stuck");
      return;
    }
    await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `"${title}": ${body.done} of ${body.tasks} parts done and brought together`, sid, lane: MAIN_LANE }));
    // Its parts' lanes and copies, once their work is in the task's copy cleanly: a part that came back with conflicts, or didn't
    // get through, keeps its copy for you to look at.
    if (tidiesIdle(m) && d.retire && st?.hub) {
      const evs = await d.events(sid);
      let cleared = 0;
      for (const [task, run] of Object.entries(st.hub.runs)) {
        if (!run.lane || run.status !== "done") continue;
        const merged = evs.findLast((e) => e.body.type === "hub.merged" && e.body.id === st.hub!.id && e.body.task === task);
        if (!merged || merged.body.type !== "hub.merged" || merged.body.conflicts.length) continue;
        await d.retire(sid, run.lane, st.engines[run.lane]?.cwd ?? null).catch((e: Error) => say(`[managers] clear part: ${e.message}`));
        cleared++;
      }
      if (cleared) await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Cleared ${cleared === 1 ? "its part's copy" : `its ${cleared} parts' copies`}: their work is in "${title}"`, sid, lane: MAIN_LANE }));
    }
    // One look over the whole, by the agent in the task's own copy: the parts fit, the checks run, nothing committed. Its turn's
    // end is then checked (or made ready) as any thread's is.
    reviewing.add(sid);
    await d.tell(sid, MAIN_LANE, splitReview(title, body));
  };
  /** A split's review turn ended, with checks off: ready as it is. */
  const reviewed = async (m: Manager, sid: string, st: SessionState | null) => {
    reviewing.delete(sid);
    if (checksWork(m)) return;
    const item = d.readyOf ? await d.readyOf(sid, MAIN_LANE).catch(() => null) : null;
    if (!item) return;
    const title = st?.title || "a big task";
    await d.managers.update(m.id, (cur) => logged(withReady(cur, { ...item, at: now() }), { at: now(), kind: "checked", text: `"${title}" is ready: its parts are together`, sid, lane: MAIN_LANE }));
    d.notify?.(m, { kind: "ready", item: { ...item, at: now() } });
    await goalMoved(m, sid, "ready");
  };

  /** Crossovers told once each: `${from}>${to}:${paths}`. */
  const crossTold = new Set<string>();
  /** Files this thread changed that another thread in the project, still working, is about to change: the Captain tells it. */
  const crossovers = async (m: Manager, sid: string, lane: string, st: SessionState | null) => {
    if (!m.on || m.level === "watch" || !st) return;
    const rel = (s2: SessionState, l: string, p: string) => {
      const base = (s2.engines[l]?.cwd ?? "").replace(/[\\/]+$/, "");
      return base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
    };
    const changed = (st.wrote?.[lane] ?? st.intents?.[lane]?.paths ?? []).map((p) => rel(st, lane, p));
    if (!changed.length) return;
    const others: { sid: string; lane: string; paths: string[] }[] = [];
    for (const other of await d.sessions(await d.me())) {
      if (ownSessions.has(other)) continue;
      const os = other === sid ? st : await d.state(other).catch(() => null);
      if (!os) continue;
      for (const l of Object.keys(os.engines)) {
        if ((other === sid && l === lane) || statusAt(os, l) !== "running") continue;
        const f = laneFolder(os, l);
        if (!f || d.folderKey(f) !== m.project.key) continue;
        const paths = [...(os.intents?.[l]?.paths ?? []), ...(os.claims ?? []).filter((c) => c.lane === l).map((c) => c.path)].map((p) => rel(os, l, p));
        if (paths.length) others.push({ sid: other, lane: l, paths });
      }
    }
    for (const o of crossoverOf(changed, others).slice(0, 2)) {
      const key = `${sid}:${lane}>${o.sid}:${o.lane}:${o.paths.join(",")}`;
      if (crossTold.has(key)) continue;
      crossTold.add(key);
      await wake(m, { kind: "crossover", sid, lane, detail: o.paths.join(", "), hard: false, other: { sid: o.sid, lane: o.lane } });
    }
  };

  /**
   * Its coding tool or model changed: a new tool starts in a session of its own on its next wake (the old lane stopped); a new
   * model restarts its lane, keeping its conversation.
   */
  const retool = async (had: Manager, next: Manager) => {
    if (had.tool !== next.tool) {
      await stopIt(had);
      await d.managers.update(next.id, (cur) => {
        const { sid: _s, lane: _l, ...rest } = cur;
        return rest as Manager;
      });
      if (had.sid) ownSessions.add(had.sid);
      return;
    }
    if (had.model !== next.model && next.sid && next.lane && next.on) {
      const me = await d.me();
      await d.startTool(next.sid, me, { tool: next.tool, cwd: next.project.folder, model: next.model, lane: next.lane, project: next.project.name });
      onModel.set(next.id, next.model);
    }
  };

  /** One event appended anywhere: does it concern a Manager? */
  const hear = async (sid: string, ev: SessionEvent): Promise<Wake | null> => {
    const list = await d.managers.list();
    if (!list.length) return null;
    // Its own session: its reply at the end of a turn.
    const own = list.find((m) => m.sid === sid);
    if (own) {
      if (ev.body.type === "run.ended") await heardReply(own, sid, ev.lane ?? MAIN_LANE);
      if (ev.body.type === "agent.usage") {
        const u = ev.body;
        await d.managers.update(own.id, (cur) => withSpend(cur, u, now()));
      }
      return null;
    }
    if (ev.actor.id === "friday" && ev.body.type === "instruction") return null;
    const lane = ev.lane ?? MAIN_LANE;
    const st = await d.state(sid);
    const folder = laneFolder(st, lane);
    if (!folder) return null;
    const m = list.find((x) => x.project.key === d.folderKey(folder));
    if (!m) return null;
    // A split's end: checked, then ready for you; or why it couldn't be done, for you.
    if (ev.body.type === "hub.ended" && st?.options.byCaptain === m.id) {
      await splitEnded(m, sid, ev.body, st).catch((e: Error) => say(`[managers] split end: ${e.message}`));
      return null;
    }
    // A task's part (a hub's lane): the hub runs, grades, retries and brings it together. Only what it asks is the Captain's.
    const part = isPart(st, lane);
    // On Run, a thread that stopped on an error (not a usage limit) is asked once to try again, with no Captain turn spent.
    if (!part && ev.body.type === "run.ended" && ev.body.outcome === "error" && m.on && m.level === "run" && !d.limitHit(ev.body.error ?? "")) {
      const k = `${sid}:${lane}`;
      const last = retried.get(k);
      if (last === undefined || now() - last > RETRY_WINDOW_MS) {
        retried.set(k, now());
        const title = st?.title || "a thread";
        const err = (ev.body.error ?? "").slice(0, 200);
        setTimeoutFn(() => void d.tell(sid, lane, `The last turn stopped on an error${err ? ` (${err})` : ""}. Try that again, carrying on where you were.`).catch(() => false), d.retryMs ?? RETRY_MS);
        await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Asked "${title}" to try again after an error`, sid, lane }));
        return null;
      }
    }
    // Shipped: committed (and pushed or a PR) from the thread, its ready card goes.
    if (ev.body.type === "folder.committed" && !ev.body.error) {
      if ((m.ready ?? []).some((r) => r.sid === sid)) await doneReady(m, sid);
      await goalMoved(m, sid, "shipped");
    }
    if (ev.body.type === "run.ended" && ev.body.outcome === "done" && m.queue.length) await startQueued(m).catch((e: Error) => say(`[managers] queue: ${e.message}`));
    // A turn that ended asking in plain text (how coding tools ask) is a question too; one that ended asking leave to go on, or
    // with its plan unfinished, is work the Captain can keep going.
    const ended = ev.body.type === "run.ended" && ev.body.outcome !== "error";
    const w = part ? (ev.body.type === "agent.question" ? wakeFor(m, sid, ev, d.limitHit) : null) : (wakeFor(m, sid, ev, d.limitHit) ?? (ended ? (asksWake(m, sid, lane, st?.asks?.[lane]) ?? (await turnEnd(m, sid, lane, st))) : null));
    if (part) {
      if (w) await wake(m, w);
      return w;
    }
    if (w) await wake(m, w);
    if (ended) await crossovers(m, sid, lane, st).catch((e: Error) => say(`[managers] crossover: ${e.message}`));
    // Done with nothing to ask: its work is checked; and a check's result, read.
    if (ended && !w && ev.body.type === "run.ended" && ev.body.outcome === "done") await checkEnd(m, sid, lane, ev.seq, st);
    if (ev.body.type === "run.ended" && lane === MAIN_LANE && reviewing.has(sid)) await reviewed(m, sid, st);
    if (ev.body.type === "proof.tests" || (ev.body.type === "proof.status" && ev.body.stage === "failed")) await checkRead(m, sid, lane, ev.seq, st).catch((e: Error) => say(`[managers] check result: ${e.message}`));
    return w;
  };

  /**
   * The minute's look: lanes in a managed project that have been running with nothing new for STUCK_MS wake their Manager once per
   * stretch; a Manager on Run with a queue and a quiet project starts the next task.
   */
  const tick = async (): Promise<void> => {
    const list = (await d.managers.list()).filter((m) => m.on);
    if (!list.length) return;
    const me = await d.me();
    const byKey = new Map(list.map((m) => [m.project.key, m]));
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      const running = Object.keys(st.engines).filter((l) => statusAt(st, l) === "running").map((l) => [l, runAt(st, l)!] as const);
      if (!running.length) continue;
      const evs = await d.events(sid);
      for (const [lane] of running) {
        const f = laneFolder(st, lane);
        const m = f ? byKey.get(d.folderKey(f)) : undefined;
        if (!m || m.level === "watch") continue;
        const last = evs.findLast((e) => (e.lane ?? MAIN_LANE) === lane);
        if (!last || now() - last.ts < STUCK_MS) continue;
        const k = `${sid}:${lane}`;
        if (stuckTold.get(k) === last.seq) continue;
        stuckTold.set(k, last.seq);
        await stuckRung(m, sid, lane, st, evs, me);
      }
    }
    for (const m of list) if (m.level === "run" && m.queue.length) await startQueued(m).catch((e: Error) => say(`[managers] queue: ${e.message}`));
    await tidy(list, me).catch((e: Error) => say(`[managers] tidy: ${e.message}`));
    await awayLook(list).catch((e: Error) => say(`[managers] away: ${e.message}`));
    await lookOver(list, me).catch((e: Error) => say(`[managers] look: ${e.message}`));
  };

  /**
   * Its look over the whole project, every LOOK_MS, with no Captain turn (Arun, 2026-11-25: "it only reacts… it never looks over the
   * whole project"): its notices kept for the panel; two working threads about to change the same files woken about once (Help and
   * Run), so it tells them; and, once a day after DIGEST_HOUR, a digest in its conversation and on your phone.
   */
  const lookOver = async (list: readonly Manager[], me: Me) => {
    const due = list.filter((m) => !m.lookedAt || now() - m.lookedAt >= (d.lookMs ?? LOOK_MS));
    if (!due.length) return;
    const byKey = new Map(due.map((m) => [m.project.key, m]));
    const found = new Map<string, Notice[]>(due.map((m) => [m.id, []]));
    const counts = new Map<string, { running: number; waiting: number }>(due.map((m) => [m.id, { running: 0, waiting: 0 }]));
    /** Working lanes' planned files, by project: for overlaps. */
    const working = new Map<string, { sid: string; lane: string; title: string; paths: string[] }[]>();
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      let evs: SessionEvent[] | null = null;
      // Its pull request merged (Arun, 2026-11-25: "after merge… tidies up"): on Run with tidying on, its tools are stopped (its copy
      // left for Storage's own clean-up, which takes merged copies), its ready card cleared, its goal's thread shipped. Said once.
      const owner = Object.keys(st.engines).map((l) => laneFolder(st, l)).find(Boolean) ?? null;
      const pm = owner ? byKey.get(d.folderKey(owner)) : undefined;
      if (pm && tidiesIdle(pm) && st.pr?.url && !mergedTold.has(sid)) {
        const merged = st.pr.merged || (d.prState ? (await d.prState(sid, st.pr.url).catch(() => null)) === "merged" : false);
        if (merged) {
          mergedTold.add(sid);
          for (const [lane, e] of Object.entries(st.engines)) if (e.online && statusAt(st, lane) !== "running") await d.stop(sid, me, lane).catch(() => {});
          await d.managers.update(pm.id, (cur) => logged(clearReady(cur, sid) ?? cur, { at: now(), kind: "said", text: `"${st.title || "a thread"}" merged: stopped its tools`, sid }));
          await goalMoved(pm, sid, "shipped");
          continue;
        }
      }
      for (const lane of Object.keys(st.engines)) {
        if (isPart(st, lane)) continue;
        const f = laneFolder(st, lane);
        const m = f ? byKey.get(d.folderKey(f)) : undefined;
        if (!m) continue;
        const title = st.title || "a thread";
        const status = statusAt(st, lane);
        const c = counts.get(m.id)!;
        if (status === "running") {
          c.running++;
          const base = (st.engines[lane]?.cwd ?? "").replace(/[\\/]+$/, "");
          const rel = (p: string) => (base && p.startsWith(base + "/") ? p.slice(base.length + 1) : p);
          const paths = [...(st.intents?.[lane]?.paths ?? []), ...(st.claims ?? []).filter((x) => x.lane === lane).map((x) => x.path)].map(rel);
          if (paths.length) working.set(m.id, [...(working.get(m.id) ?? []), { sid, lane, title, paths }]);
          continue;
        }
        evs ??= await d.events(sid);
        const last = evs.findLast((x) => (x.lane ?? MAIN_LANE) === lane);
        const since = last ? now() - last.ts : 0;
        const asks = !!st.asks?.[lane]?.questions.length || !!st.approvals?.[lane];
        if (asks) c.waiting++;
        if (asks && since >= WAITING_MS) found.get(m.id)!.push({ id: `waiting:${sid}:${lane}`, kind: "waiting", text: `"${title}" has waited on you ${Math.round(since / 3600_000)}h`, sid, at: now() });
        else if (!asks && st.diffs?.[lane]?.files.length && since >= UNSHIPPED_MS && !(m.ready ?? []).some((r) => r.sid === sid))
          found.get(m.id)!.push({ id: `unshipped:${sid}:${lane}`, kind: "unshipped", text: `"${title}" has changes nobody shipped, ${Math.round(since / 86_400_000) || 1}d old`, sid, at: now() });
      }
    }
    for (const m of due) {
      const notes = found.get(m.id)!;
      // Two working threads about to change the same files.
      const w = working.get(m.id) ?? [];
      for (let i = 0; i < w.length; i++)
        for (let j = i + 1; j < w.length; j++) {
          const a = w[i]!, b = w[j]!;
          if (a.sid === b.sid && a.lane === b.lane) continue;
          const both = a.paths.filter((p) => b.paths.includes(p)).slice(0, 4);
          if (!both.length) continue;
          notes.push({ id: `overlap:${a.sid}:${a.lane}:${b.sid}:${b.lane}`, kind: "overlap", text: `"${a.title}" and "${b.title}" are both about to change ${both.join(", ")}`, sid: a.sid, at: now() });
          const key = `${a.sid}:${a.lane}>${b.sid}:${b.lane}:${both.join(",")}`;
          if (m.level !== "watch" && !crossTold.has(key)) {
            crossTold.add(key);
            await wake(m, { kind: "crossover", sid: a.sid, lane: a.lane, detail: both.join(", "), hard: false, other: { sid: b.sid, lane: b.lane } });
          }
        }
      // Ready work that reads risky.
      for (const r of m.ready ?? []) if (r.risk === "high") notes.push({ id: `risky:${r.sid}:${r.lane}`, kind: "risky", text: `"${r.title}" is ready but reads risky: ${r.why}`, sid: r.sid, at: now() });
      const day = dayOf(now());
      const c = counts.get(m.id)!;
      // Once a day, what stands, said only when there is something to say: "all quiet" in its conversation and on your phone was
      // noise (Arun's first look at the window, 2026-11-25, read "Today in edge: all quiet." and nothing else). The day counts as
      // done either way, so it isn't worked out again at every look.
      const dueDigest = m.on && m.digestDay !== day && new Date(now()).getHours() >= DIGEST_HOUR && !inQuiet(m, now());
      const standing = dueDigest ? [(m.ready?.length ?? 0) && `${m.ready!.length} ready to ship`, c.waiting + openAsks(m, now()).length && `${c.waiting + openAsks(m, now()).length} waiting on you`, c.running && `${c.running} running`, m.queue.length && `${m.queue.length} queued`, notes.filter((n) => n.kind === "unshipped").length && `${notes.filter((n) => n.kind === "unshipped").length} unshipped`, (m.goals ?? []).filter((g) => g.status === "working").length && `${(m.goals ?? []).filter((g) => g.status === "working").length} goal${(m.goals ?? []).filter((g) => g.status === "working").length === 1 ? "" : "s"} under way`].filter(Boolean).join(", ") : "";
      const digest = standing ? `Today in ${m.project.name}: ${standing}.` : null;
      await d.managers.update(m.id, (cur) => {
        let next: Manager = { ...cur, notices: notes, lookedAt: now() };
        if (dueDigest) next = { ...next, digestDay: day };
        if (digest) next = withChat(next, "captain", digest, now());
        return next;
      });
      const about = notes[0]?.sid ?? m.ready?.[0]?.sid;
      if (digest && about) d.notify?.(m, { kind: "report", text: digest, sid: about });
    }
  };

  /**
   * The person's Away, as each Captain keeps it: begun (when it began and is to end), moved, or over (when they came back). Over,
   * what it did meanwhile goes to their phone in a line if they're not at the computer; the panel shows it in full.
   */
  const awayLook = async (list: readonly Manager[]) => {
    if (!d.away) return;
    const a = await d.away().catch(() => null);
    const on = a && a.until > now() ? a : null;
    for (const m of list) {
      const had = m.away;
      if (on && (!had || had.back !== undefined || had.since !== on.since || had.until !== on.until)) {
        await d.managers.update(m.id, (cur) => ({ ...cur, away: { since: on.since, until: on.until } }));
      } else if (!on && had && had.back === undefined) {
        const back = Math.min(now(), had.until);
        const next = await d.managers.update(m.id, (cur) => (cur.away && cur.away.back === undefined ? { ...cur, away: { ...cur.away, back } } : null));
        const report = next ? awayReport(next, now()) : null;
        const about = report && (report.waiting[0]?.sid ?? report.ready[0]?.sid ?? report.decided[0]?.sid);
        if (report && about && d.notify) d.notify(m, { kind: "report", text: awayLineFor(report), sid: about });
      }
    }
  };

  /**
   * Idle threads in a project whose Captain tidies (Run): a lane whose tool is on but quiet for IDLE_MS, not running, not waiting
   * on the person, in a session they don't have open, has its tool stopped. Its folder and history stay; opening the thread starts
   * it again. Never the Captain's own, never a split's parts (the hub's).
   */
  const tidy = async (list: readonly Manager[], me: Me) => {
    const tidying = list.filter(tidiesIdle);
    if (!tidying.length) return;
    const byKey = new Map(tidying.map((m) => [m.project.key, m]));
    const idle = d.idleMs ?? IDLE_MS;
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st) continue;
      const lanes = Object.entries(st.engines).filter(([lane, e]) => e.online && e.tool && !isPart(st, lane));
      if (!lanes.length) continue;
      let evs: SessionEvent[] | null = null;
      let viewed: boolean | null = null;
      for (const [lane, e] of lanes) {
        const f = laneFolder(st, lane);
        const m = f ? byKey.get(d.folderKey(f)) : undefined;
        if (!m) continue;
        if (statusAt(st, lane) !== "idle" || st.asks?.[lane]?.questions.length) continue;
        evs ??= await d.events(sid);
        const last = evs.findLast((x) => (x.lane ?? MAIN_LANE) === lane);
        if (!last || now() - last.ts < idle) continue;
        viewed ??= d.viewing ? await d.viewing(sid).catch(() => true) : false;
        if (viewed) break;
        await d.stop(sid, me, lane);
        const hours = Math.round((now() - last.ts) / 3600_000);
        await d.managers.update(m.id, (cur) => logged(cur, { at: now(), kind: "said", text: `Stopped ${e.tool ? (TOOL_LABEL[e.tool] ?? e.tool) : "the tool"} in "${st.title || "a thread"}", quiet ${hours ? `${hours}h` : "a while"}; it starts again when you open the thread`, sid, lane }));
      }
    }
  };

  /**
   * Each Captain's threads for its window (the UI session's redesign, 2026-11-25): the project's own threads, never the Captain's
   * own session, the sessions it started for itself or a split's parts. A thread is working while a lane runs, needs while a lane
   * waits on the person (a question or a go-ahead), stopped when its tools are all stopped (tidied, or by hand), and idle otherwise;
   * since is when that last changed. Newest first, twelve at most. Read from session state alone, no events, and kept 3 s.
   */
  let threadsKept: { at: number; by: Map<string, ManagerThread[]> } | null = null;
  const threadsOf = async (list: readonly Manager[], me: Me): Promise<Map<string, ManagerThread[]>> => {
    if (threadsKept && now() - threadsKept.at < 3000) return threadsKept.by;
    const byKey = new Map(list.map((m) => [m.project.key, m]));
    const by = new Map<string, ManagerThread[]>(list.map((m) => [m.id, []]));
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid) || list.some((m) => m.sid === sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st || st.options?.manager) continue;
      const lanes = Object.keys(st.engines).filter((l) => !isPart(st, l));
      const mine = lanes.filter((l) => {
        const f = laneFolder(st, l);
        return !!f && byKey.has(d.folderKey(f));
      });
      if (!mine.length) continue;
      const m = byKey.get(d.folderKey(laneFolder(st, mine[0]!)!))!;
      const run = (l: string) => runAt(st, l);
      const running = mine.filter((l) => run(l)?.status === "running");
      const needs = mine.filter((l) => st.asks?.[l]?.questions.length || st.approvals?.[l]);
      const withTool = mine.filter((l) => st.engines[l]?.tool);
      const state: ManagerThread["state"] = running.length ? "working" : needs.length ? "needs" : withTool.length && withTool.every((l) => !st.engines[l]!.online) ? "stopped" : "idle";
      const pick = state === "working" ? running : state === "needs" ? needs : mine;
      const since = Math.max(0, ...pick.map((l) => run(l)?.sinceAt ?? 0));
      const main = mine.includes(MAIN_LANE) ? MAIN_LANE : mine[0]!;
      const tool = st.engines[main]?.tool;
      by.get(m.id)!.push({ sid, title: st.title || "A thread", state, since, ...(tool ? { tool } : {}) });
    }
    for (const [id, ts] of by) by.set(id, ts.sort((a, b) => b.since - a.since).slice(0, 12));
    threadsKept = { at: now(), by };
    return by;
  };

  /**
   * Projects worth a Captain (Arun, 2026-11-25: "how to get it started… getting started is hidden"): two or more of the person's
   * threads working in one folder in the last three days, none with a Captain yet, not put away. Busiest first.
   */
  const suggest = async (me: Me, putAway: ReadonlySet<string>): Promise<{ key: string; name: string; folder: string; threads: number; running: number }[]> => {
    const have = new Set((await d.managers.list()).map((m) => m.project.key));
    const by = new Map<string, { key: string; name: string; folder: string; sids: Set<string>; running: number }>();
    for (const sid of await d.sessions(me)) {
      if (ownSessions.has(sid)) continue;
      const st = await d.state(sid).catch(() => null);
      if (!st || st.options?.manager) continue;
      const evs = await d.events(sid).catch(() => [] as SessionEvent[]);
      if (!evs.length || now() - evs.at(-1)!.ts > 3 * 86_400_000) continue;
      for (const lane of Object.keys(st.engines)) {
        const f = laneFolder(st, lane);
        if (!f) continue;
        const key = d.folderKey(f);
        if (have.has(key) || putAway.has(key)) continue;
        const p = by.get(key) ?? { key, name: f.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || f, folder: f, sids: new Set<string>(), running: 0 };
        p.sids.add(sid);
        if (statusAt(st, lane) === "running") p.running++;
        by.set(key, p);
      }
    }
    return [...by.values()]
      .filter((p) => p.sids.size >= 2)
      .map((p) => ({ key: p.key, name: p.name, folder: p.folder, threads: p.sids.size, running: p.running }))
      .sort((a, b) => b.threads - a.threads || b.running - a.running)
      .slice(0, 5);
  };

  return { threadsOf, suggest, sayTo, cancelGoal, doneReady, ensure, stop: stopIt, hear, tick, startQueued, wake, flush, answer, retool, forFolder, ownSessions, runningIn };
}

export type ManagersRun = ReturnType<typeof managersRun>;
export const newSid = () => randomBytes(6).toString("base64url");
