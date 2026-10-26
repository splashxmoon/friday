import { engineName, MAIN_LANE, type SessionEvent } from "./types.js";
import { givenName, pendingFor, runOf, type SessionState } from "./session/projection.js";

/**
 * "Where we left off": the note the next person, or the next day's agent, needs.
 *
 * A session that stops mid-task leaves its state spread across a conversation: what was asked, what got done, what is
 * half done, what is waiting on somebody. This reads that out of the log and writes it down once, in the order somebody
 * picking it up asks: what is this, where does it stand, what is open, what was decided, and what to do first.
 *
 * Deterministic on purpose, like the catch-up digest: no model call, so it is instant and free, and everything in it is
 * something the log says. A section with nothing behind it is left out, never padded.
 */

/** A line with a title and, under it, the rest: for the lists that are read at a glance. `tone` colours its marker. */
export interface RichItem {
  title: string;
  sub?: string;
  tone?: "go" | "hold" | "bad" | "ok" | "";
  /** A file row: the counts beside the path, drawn in colour rather than said in words. */
  file?: { add: number; del: number; status: "new" | "edited" | "deleted" };
}

export interface LeftOffSection {
  label: string;
  items: string[];
  /** The same lines with their parts apart, where that helps; `items` is always there, for the text version. */
  rich?: RichItem[];
}

/** Where the session stands, in one look: blocked, working, or calm. */
export interface LeftOffStatus {
  tone: "blocked" | "working" | "calm" | "empty";
  /** One sentence, the first thing worth knowing. */
  line: string;
  /** Short facts to show beside it: "7 agents", "4 files", "3 open". */
  stats: { label: string; value: string }[];
}

export interface LeftOff {
  title: string;
  status: LeftOffStatus;
  /** The one thing to do first, or "" when nothing is waiting. */
  next: string;
  sections: LeftOffSection[];
  /** The same note as text, for pasting and for the agent. */
  markdown: string;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const first = (n: string) => n.split(/\s+/)[0] ?? n;
/** "4m", "1h 12m", "2d 3h": enough to know whether this was a moment or a shift. */
export const fmtDuration = (ms: number): string => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
};
/** "48k", "1.2M": the size of the bill, not the invoice. */
export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export const laneLabel = (state: SessionState, lane: string): string => {
  const e = state.engines[lane];
  const given = givenName(state, lane);
  if (e?.tool) return given ?? `${e.hostName}'s ${engineName(e.tool)}`;
  if (lane === MAIN_LANE) return given ?? state.options.agent?.name ?? "Friday Code";
  const l = state.lanes.find((x) => x.id === lane);
  return l?.agent?.name ?? l?.name ?? "An agent";
};

interface Step {
  title: string;
  done: boolean;
}

/** The newest plan an agent wrote, as its steps and which are finished. */
export function latestPlan(events: SessionEvent[], lane: string): Step[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if ((e.lane ?? MAIN_LANE) !== lane || e.body.type !== "agent.message") continue;
    const call = e.body.toolCalls.findLast((c) => c.name === "update_plan" || c.name === "todo");
    if (!call) continue;
    try {
      const a = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
      const raw = Array.isArray(a.steps) ? a.steps : Array.isArray(a.todos) ? a.todos : Array.isArray(a.items) ? a.items : [];
      return raw.slice(0, 20).flatMap((t) => {
        const o = (t ?? {}) as { content?: unknown; title?: unknown; status?: unknown };
        const title = typeof o.content === "string" ? o.content : typeof o.title === "string" ? o.title : "";
        const s = String(o.status ?? "pending");
        return title ? [{ title, done: s === "completed" || s === "done" }] : [];
      });
    } catch {
      return [];
    }
  }
  return [];
}

export function leftOff(state: SessionState, events: SessionEvent[], now = Date.now()): LeftOff {
  const sections: LeftOffSection[] = [];
  const add = (label: string, items: (string | false | undefined | "")[], rich?: RichItem[]) => {
    const kept = items.filter((x): x is string => !!x);
    if (kept.length) sections.push({ label, items: kept, ...(rich?.length ? { rich } : {}) });
  };

  // What this is: the first thing a person asked for, in their words.
  const ask = events.find((e) => e.body.type === "instruction" && e.actor.kind === "human" && !e.body.text.startsWith("[session]"));
  const goal = ask && ask.body.type === "instruction" ? `${ask.actor.name} asked: ${clip(ask.body.text, 300)}` : "";
  add("The task", [goal]);

  // Where it stands: each agent that has done anything, and what it last said.
  const lanes = [MAIN_LANE, ...state.lanes.map((l) => l.id)];
  const standing: string[] = [];
  const standingRich: RichItem[] = [];
  for (const lane of lanes) {
    const mine = events.filter((e) => (e.lane ?? MAIN_LANE) === lane);
    if (!mine.some((e) => e.body.type === "run.started")) continue;
    const run = runOf(state, lane);
    const state_ = run.status === "running" ? "is working" : run.status === "paused" ? "is paused" : run.status === "waiting_for_human" ? "is waiting on a person" : run.status === "error" ? `stopped: ${clip(run.error ?? "it hit an error", 120)}` : "finished its last run";
    const said = mine.findLast((e) => e.body.type === "agent.message" && e.body.text.trim());
    const words = said && said.body.type === "agent.message" ? ` Its last words: “${clip(said.body.text.split(/\n\n/)[0] ?? "", 260)}”` : "";
    standing.push(`${laneLabel(state, lane)} ${state_}.${words}`);
    standingRich.push({
      title: laneLabel(state, lane),
      sub: `${state_[0]!.toUpperCase()}${state_.slice(1)}.${said && said.body.type === "agent.message" ? ` “${clip(said.body.text.split(/\n\n/)[0] ?? "", 200)}”` : ""}`,
      tone: run.status === "running" ? "go" : run.status === "error" ? "bad" : run.status === "idle" ? "ok" : "hold",
    });
  }
  add("Where it stands", standing, standingRich);

  // What changed: files the agents wrote, and what has been committed.
  const files = new Map<string, string>();
  /** The same files with their numbers apart, for the rows the dialog draws. */
  const fileRows = new Map<string, NonNullable<RichItem["file"]>>();
  for (const e of events) {
    if (e.body.type === "folder.edited") {
      files.set(e.body.path, e.body.created ? "new" : "edited");
      const had = fileRows.get(e.body.path);
      fileRows.set(e.body.path, { add: had?.add ?? 0, del: had?.del ?? 0, status: e.body.created ? "new" : (had?.status ?? "edited") });
    } else if (e.body.type === "agent.diff")
      for (const f of e.body.files) {
        files.set(f.path, `+${f.additions} −${f.deletions}`);
        fileRows.set(f.path, { add: f.additions, del: f.deletions, status: f.status === "added" ? "new" : f.status === "deleted" ? "deleted" : "edited" });
      }
  }
  const commit = events.findLast((e) => e.body.type === "folder.committed" && !e.body.error);
  const committed = commit && commit.body.type === "folder.committed" ? commit.body : null;
  const sinceCommit = commit ? new Set(events.filter((e) => e.seq > commit.seq && (e.body.type === "folder.edited" || e.body.type === "agent.diff")).flatMap((e) => (e.body.type === "folder.edited" ? [e.body.path] : e.body.type === "agent.diff" ? e.body.files.map((f) => f.path) : []))) : new Set(files.keys());
  // The rows the dialog draws: the commit's standing first, then every file with its numbers.
  const adds = [...fileRows.values()].reduce((n, f) => n + f.add, 0);
  const dels = [...fileRows.values()].reduce((n, f) => n + f.del, 0);
  const fresh = [...fileRows.values()].filter((f) => f.status === "new").length;
  const changedRich: RichItem[] = [
    ...(committed
      ? [
          {
            title: `Last commit ${committed.sha.slice(0, 7)}${committed.branch ? ` on ${committed.branch}` : ""}`,
            sub: `${committed.pushed ? "Pushed" : "Not pushed"}${committed.prUrl ? ` · ${committed.prUrl}` : ""}${sinceCommit.size ? ` · ${sinceCommit.size} file${sinceCommit.size === 1 ? "" : "s"} changed since, not committed` : ""}`,
            tone: committed.pushed && !sinceCommit.size ? ("go" as const) : ("hold" as const),
          },
        ]
      : files.size
        ? [{ title: "Nothing committed yet", sub: `${files.size} file${files.size === 1 ? "" : "s"} · +${adds} −${dels}${fresh ? ` · ${fresh} new` : ""}`, tone: "hold" as const }]
        : []),
    ...[...fileRows.entries()].map(([path, f]) => ({ title: path, tone: f.status === "new" ? ("go" as const) : f.status === "deleted" ? ("bad" as const) : ("" as const), file: f })),
  ];
  add(
    "What changed",
    [
      files.size ? `${files.size} file${files.size === 1 ? "" : "s"} touched: ${[...files.entries()].slice(0, 8).map(([p, how]) => `${p} (${how})`).join(", ")}${files.size > 8 ? `, and ${files.size - 8} more` : ""}.` : "",
      committed ? `Last commit ${committed.sha.slice(0, 7)}${committed.branch ? ` on ${committed.branch}` : ""}${committed.pushed ? ", pushed" : ", not pushed"}${committed.prUrl ? `. Pull request: ${committed.prUrl}` : ""}.` : "",
      sinceCommit.size && committed ? `${sinceCommit.size} file${sinceCommit.size === 1 ? "" : "s"} changed since then and not committed.` : files.size && !committed ? "Nothing committed yet." : "",
    ],
    changedRich,
  );

  // What is open.
  const open: string[] = [];
  const blocking = new Set<number>();
  const questions = Object.values(state.openQuestions).sort((a, b) => a.seq - b.seq);
  for (const q of questions) open.push(`${q.toName} has an unanswered question from ${questions.length > 1 ? laneLabel(state, q.lane) : "the agent"}: “${clip(q.question, 200)}”`);
  for (const [lane, ask_] of Object.entries(state.approvals)) open.push(`${laneLabel(state, lane)} is waiting for a yes or no to run ${ask_.items.length === 1 ? `\`${clip(ask_.items[0] ?? "", 80)}\`` : `${ask_.items.length} commands`}.`);
  for (const lane of lanes) {
    const n = pendingFor(state, lane).length;
    if (n) open.push(`${n} message${n === 1 ? "" : "s"} queued for ${laneLabel(state, lane)}, not yet read.`);
  }
  for (const lane of lanes) {
    const steps = latestPlan(events, lane);
    const left = steps.filter((s) => !s.done);
    if (steps.length && left.length) open.push(`${laneLabel(state, lane)}'s plan has ${left.length} of ${steps.length} steps left: ${left.slice(0, 4).map((s) => s.title).join("; ")}${left.length > 4 ? "…" : ""}`);
  }
  const threads = state.threads.filter((t) => !t.resolved);
  if (threads.length) open.push(`${threads.length} open review comment${threads.length === 1 ? "" : "s"}: ${threads.slice(0, 4).map((t) => `${t.path}:${t.line} “${clip(t.text, 60)}”`).join("; ")}${threads.length > 4 ? "…" : ""}`);
  // Commands that failed and were never run again successfully.
  const ran = events.filter((e) => e.body.type === "folder.ran");
  const failing = new Map<string, string>();
  for (const e of ran) if (e.body.type === "folder.ran") (e.body.isError ? failing.set(e.body.command, e.body.command) : failing.delete(e.body.command));
  for (const c of [...failing.keys()].slice(-3)) open.push(`\`${clip(c, 80)}\` last failed.`);
  // What stops everything is shown as such; the rest is work still to do.
  const stops = (t: string) => /unanswered question|waiting for a yes or no|last failed/.test(t);
  add("Still open", open, open.map((t) => ({ title: t, tone: stops(t) ? "bad" : "hold" })));
  void blocking;

  // What was decided on the way, which is what a newcomer would otherwise re-argue.
  const decided: string[] = [];
  const approved = events.findLast((e) => e.body.type === "plan.approved");
  if (approved && approved.body.type === "plan.approved") decided.push(`${approved.actor.name} approved the plan${approved.body.steps ? ` with changes: ${approved.body.steps.map((s, i) => `${i + 1}. ${clip(s, 80)}`).join(" ")}` : ""}.`);
  for (const e of events) if (e.body.type === "plan.reviewed" && e.body.verdict === "changes" && e.body.note) decided.push(`${e.actor.name} asked for plan changes: “${clip(e.body.note, 140)}”`);
  for (const m of state.memory.filter((x) => x.key !== "left-off" && x.text).slice(-5)) decided.push(clip(m.text, 200));
  add("Decided along the way", decided.slice(-8));

  // Who is here.
  const people = Object.values(state.members).filter((m) => !m.removed);
  const driver = state.driver ? `${state.driver.name} is driving.` : "Nobody is driving.";
  add("People", [`${people.map((p) => `${first(p.name)} (${p.role})`).join(", ")}. ${driver}`]);

  // What to do first: the most blocking thing.
  const next: string[] = [];
  if (questions[0]) next.push(`Answer the agent's question: “${clip(questions[0].question, 120)}”`);
  else if (Object.keys(state.approvals).length) next.push("Say yes or no to the command the agent is waiting on.");
  else if (failing.size) next.push(`Fix what failed: \`${clip([...failing.keys()].at(-1) ?? "", 80)}\`.`);
  else if (threads.length) next.push(`Deal with the ${threads.length} open review comment${threads.length === 1 ? "" : "s"}, starting with ${threads[0]!.path}:${threads[0]!.line}.`);
  else {
    const left = lanes.flatMap((l) => latestPlan(events, l).filter((s) => !s.done));
    if (left.length) next.push(`Carry on with the plan: ${left[0]!.title}`);
    else if (sinceCommit.size && committed) next.push("Review what changed since the last commit, and commit it.");
    else if (files.size && !committed) next.push("Review the changes and commit them.");
  }
  add("Start with", next);

  // The one-look answer: is anything stuck, is anything running, or is it all quiet.
  const blocked = open.find(stops);
  const working = lanes.filter((l) => runOf(state, l).status === "running").length;
  const status: LeftOffStatus = !events.some((e) => e.body.type === "run.started") && !open.length
    ? { tone: "empty", line: "Nothing has run here yet.", stats: [] }
    : blocked
      ? { tone: "blocked", line: clip(blocked.replace(/\.$/, ""), 120), stats: [] }
      : working
        ? { tone: "working", line: `${working} agent${working === 1 ? " is" : "s are"} working right now.`, stats: [] }
        : { tone: "calm", line: open.length ? `Nothing is stuck. ${open.length} thing${open.length === 1 ? " is" : "s are"} still open.` : "Nothing is stuck and nothing is open.", stats: [] };
  const ranLanes = lanes.filter((l) => events.some((e) => (e.lane ?? MAIN_LANE) === l && e.body.type === "run.started")).length;
  // How long agents were at it, and what that cost: the first run's start to the last run's end, and the provider's own token counts.
  const starts = events.filter((e) => e.body.type === "run.started").map((e) => e.ts);
  const ends = events.filter((e) => e.body.type === "run.ended").map((e) => e.ts);
  const workedMs = starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0;
  const tokens = events.reduce((n, e) => n + (e.body.type === "agent.message" ? (e.body.tokens ?? 0) : 0), 0);
  status.stats = [
    ...(ranLanes ? [{ label: ranLanes === 1 ? "agent" : "agents", value: String(ranLanes) }] : []),
    ...(workedMs >= 60_000 ? [{ label: "worked", value: fmtDuration(workedMs) }] : []),
    ...(tokens ? [{ label: "tokens", value: fmtTokens(tokens) }] : []),
    ...(files.size ? [{ label: files.size === 1 ? "file changed" : "files changed", value: String(files.size) }] : []),
    ...(open.length ? [{ label: "still open", value: String(open.length) }] : []),
    ...(people.length > 1 ? [{ label: "people", value: String(people.length) }] : []),
  ];

  const title = state.title || "This session";
  const when = new Date(now).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const markdown = [`# Where we left off: ${title}`, `_Written ${when}._`, ...sections.flatMap((s) => ["", `## ${s.label}`, ...s.items.map((i) => `- ${i}`)])].join("\n");
  return { title, status, next: next[0] ?? "", sections, markdown };
}
