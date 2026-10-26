import { commandFailed, receiptOf } from "./receipt.js";
import type { SessionState } from "./session/projection.js";
import type { SessionEvent } from "./types.js";

/**
 * What a pull request should say, written from the session that made it.
 *
 * A reviewer opening a PR sees a diff and has to guess the rest: what was
 * asked for, what was decided on the way, who was steering, and whether the
 * work was ever checked. All of that is in the session's log already. This
 * reads it out, so the description is the session's own account of itself
 * rather than a summary somebody has to remember to write.
 *
 * It only says what the log says. A section with nothing behind it is left
 * out, never filled with a hopeful sentence.
 */

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const names = (list: string[]) => (list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`);
/** Inline code that can't break out of its own backticks. */
const tick = (s: string) => `\`${s.replace(/`/g, "'")}\``;
/** A command with its environment values hidden: `TOKEN=abc npm test` is how a secret ends up in a public description. */
const safeCmd = (c: string) => c.replace(/(^|[\s;&|(])([A-Z][A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g, "$1$2=…");
/** What the person themselves wrote: a session started from an issue or a pull request carries its text after a rule. */
const ownWords = (t: string) => t.split(/\n+---\n+GitHub (?:issue|pull request) #/)[0]!;
/** The most a description holds; GitHub takes 65 K, and nobody reads past this. */
const MAX_BODY = 30_000;

/**
 * A commit subject when no model writes one: what the person asked for, when that reads as a subject on its own ("Add a
 * note on running the tests"), else the files. A question, a greeting or an essay is not a subject.
 */
export function plainCommitMessage(files: { path: string }[], asked: string): string {
  const line = (asked.split("\n").find((l) => l.trim()) ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(please|can you|could you|pls)\s+/i, "")
    .replace(/[.!\s]+$/, "");
  // A question, a greeting, an answer to the agent or an essay is not a subject.
  const usable = line.length >= 8 && line.length <= 72 && !/[?]/.test(line) && !/^(hi|hello|hey|ok|okay|yes|no|thanks|sure|go ahead|don't|do not)\b/i.test(line) && asked.split("\n").filter((l) => l.trim()).length === 1;
  if (usable) return line[0]!.toUpperCase() + line.slice(1);
  return files.length === 1 ? `Update ${files[0]!.path}` : `Update ${files.length} files`;
}

export function prBodyFor(state: SessionState, events: SessionEvent[], link?: string, replay?: string): string {
  const out: string[] = [];

  // The goal is the first thing a person asked for, in their own words — and the issue it came from, in the words GitHub
  // reads to close it when this merges.
  const first = events.find((e) => e.body.type === "instruction" && e.actor.kind === "human");
  const why = [state.options.issue ? `Closes ${state.options.issue.url}` : "", first && first.body.type === "instruction" ? clip(ownWords(first.body.text), 600) : ""].filter(Boolean);
  if (why.length) out.push(`## Why\n${why.join("\n\n")}`);

  // One person answers for it. `git blame` names a bot for an agent's change, and "the session" owns nothing: the person
  // driving when the pull request was opened is its owner, handed on with the wheel, and the session's owner when nobody was.
  const owner = state.driver?.name ?? state.members[state.ownerId]?.name;
  if (owner) out.push(`## Owner\n**${owner}** is accountable for this change: they were driving the session when it was opened.`);

  // What changed, file by file, from the diff the agents reported: a reviewer's map of where to look.
  const changed = new Map<string, { a: number; d: number }>();
  for (const e of events) if (e.body.type === "agent.diff") for (const f of e.body.files) changed.set(f.path, { a: f.additions, d: f.deletions });
  if (changed.size) {
    const rows = [...changed].slice(0, 12).map(([p, c]) => `- ${tick(p)} (+${c.a} −${c.d})`);
    out.push(`## What changed\n${rows.join("\n")}${changed.size > 12 ? `\n- …and ${changed.size - 12} more` : ""}`);
  }

  // The plan, when there was one: what was approved, as it was approved.
  const approved = events.findLast((e) => e.body.type === "plan.approved");
  if (approved && approved.body.type === "plan.approved") {
    const steps = approved.body.steps;
    out.push(`## Plan\nApproved by ${approved.actor.name}${steps ? " with changes" : ""}.${steps ? `\n${steps.map((x, i) => `${i + 1}. ${clip(x, 200)}`).join("\n")}` : ""}`);
  }

  // Decisions the agent or a person wrote down as they went: the last word on
  // each key, since a later note under the same key corrects an earlier one.
  const decisions = new Map<string, string>();
  // An empty note takes the key back out (a cleared thumb).
  for (const e of events) if (e.body.type === "memory.saved") {
    if (e.body.text) decisions.set(e.body.key, e.body.text);
    else decisions.delete(e.body.key);
  }
  if (decisions.size) out.push(`## Decisions\n${[...decisions].slice(-8).map(([k, v]) => `- **${clip(k, 80)}**: ${clip(v, 240)}`).join("\n")}`);

  // What reviewers said: who signed off on the plan, and how the comments on the code came out. A comment an agent's change
  // closed is said to be, so the reader knows which were answered by a person and which by a diff.
  const reviews: string[] = [];
  const signed = new Map<string, "approve" | "changes">();
  for (const e of events) if (e.body.type === "plan.reviewed") signed.set(e.actor.name, e.body.verdict);
  const okd = [...signed].filter(([, v]) => v === "approve").map(([n]) => n);
  if (okd.length) reviews.push(`- Signed off on the plan: ${names(okd)}`);
  const threads = state.threads;
  if (threads.length) {
    const done = threads.filter((t) => t.resolved);
    const byChange = done.filter((t) => t.auto).length;
    reviews.push(`- ${threads.length} review comment${threads.length === 1 ? "" : "s"}, ${done.length} resolved${byChange ? ` (${byChange} closed by the agent's own change)` : ""}`);
    for (const t of done.slice(0, 5)) reviews.push(`  - ${tick(`${t.path}:${t.line}`)} “${clip(t.text, 100)}”${t.auto ? " — fixed" : ""}`);
  }
  if (reviews.length) out.push(`## Review\n${reviews.join("\n")}`);

  // Who let the agents do what they asked to: each request, and who said yes or no to it. The audit a reviewer (or an
  // auditor) asks for, and that a shared key or an agent's own word can't give.
  const asked = new Map<string, string>();
  for (const e of events) if (e.body.type === "engine.approval") asked.set(e.body.id, e.body.items.join(" · ") || (e.body.scope === "turn" ? "write access for a turn" : "a command"));
  const answers: string[] = [];
  for (const e of events) {
    if (e.body.type !== "instruction" || !e.body.approval || !asked.has(e.body.approval.id)) continue;
    const who = e.actor.kind === "human" ? e.actor.name : "the session's allow list";
    answers.push(`- ${tick(clip(safeCmd(asked.get(e.body.approval.id)!), 100))}: ${e.body.approval.approve ? "allowed" : "refused"} by ${who}`);
    asked.delete(e.body.approval.id);
  }
  for (const what of [...asked.values()].slice(0, 5)) answers.push(`- ${tick(clip(safeCmd(what), 100))}: asked, never answered`);
  if (answers.length) out.push(`## Approvals\n${answers.slice(0, 15).join("\n")}${answers.length > 15 ? `\n- …and ${answers.length - 15} more` : ""}`);

  // Attempts that were undone on the way: what the change is not, said so a reviewer doesn't suggest it again.
  const undone = events.filter((e) => e.body.type === "folder.restored").length;
  if (undone) out.push(`## Tried and undone\nThe work was rewound ${undone} time${undone === 1 ? "" : "s"} before this version: the recording below shows what was tried.`);

  // What is not done, so a pull request never reads as finished when the session knows otherwise.
  const open: string[] = [];
  for (const t of threads.filter((x) => !x.resolved).slice(0, 10)) open.push(`- Open comment on ${tick(`${t.path}:${t.line}`)}: “${clip(t.text, 140)}”`);
  const failing = new Map<string, true>();
  for (const e of events) if (e.body.type === "folder.ran") (e.body.isError ? failing.set(e.body.command, true) : failing.delete(e.body.command));
  for (const c of [...failing.keys()].slice(-3)) open.push(`- ${tick(clip(safeCmd(c), 80))} last failed`);
  if (open.length) out.push(`## Not done\n${open.join("\n")}`);

  // Who steered, and what did the work. Counting instructions says how hands-on
  // each person was without claiming anything about the quality of it.
  const steered = new Map<string, number>();
  const agents = new Set<string>();
  for (const e of events) {
    if (e.body.type === "instruction" && e.actor.kind === "human") steered.set(e.actor.name, (steered.get(e.actor.name) ?? 0) + 1);
    if (e.body.type === "agent.message" && e.actor.kind === "agent") agents.add(e.actor.name);
  }
  if (steered.size) {
    const who = [...steered].map(([n, c]) => `${n} (${c} instruction${c === 1 ? "" : "s"})`);
    out.push(`## Steered by\n${names(who)}${agents.size ? `, worked by ${names([...agents])}` : ""}.`);
  }

  // Whether it was checked: the same receipt the review card shows, from the
  // commands that actually ran and what the diff actually did.
  const results = new Map<string, boolean | null>();
  for (const e of events) if (e.body.type === "tool.result") results.set(e.body.callId, commandFailed(e.body));
  const calls = events.flatMap((e) => (e.body.type === "agent.message" ? e.body.toolCalls : []));
  const files = Object.values(state.diffs).flatMap((d) => d.files);
  const answer = [...events].reverse().find((e) => e.body.type === "agent.message" && !e.body.toolCalls.length && e.body.text);
  const receipt = receiptOf({ calls, failed: (id) => results.get(id) ?? null, files, answer: answer?.body.type === "agent.message" ? answer.body.text : undefined });
  // The block a reviewer can trust without opening anything: what was run, what it said, and the recording to click
  // through to. The recording link needs no account, so it reaches people who have never used Friday.
  const testCmd = receipt.commands.filter((c) => c.test).at(-1)?.command;
  const checks = [
    `**Tests ${receipt.tests === "pass" ? "passed" : receipt.tests === "fail" ? "failed" : "not run"}**${testCmd ? ` (${tick(safeCmd(testCmd))})` : ""} · ${receipt.commands.length} command${receipt.commands.length === 1 ? "" : "s"} ran · ${receipt.files} file${receipt.files === 1 ? "" : "s"} changed`,
    ...receipt.flags.map((f) => `- ${f.level === "bad" ? "🚩" : "⚠️"} ${f.text}`),
    ...(replay ? [`▶ [Watch the run](${replay}) — a read-only recording of the session; no sign-in needed.`] : []),
  ];
  out.push(`## Verified by Friday\n${checks.join("\n")}`);

  let text = out.join("\n\n");
  if (text.length > MAX_BODY) text = `${text.slice(0, MAX_BODY)}\n\n… (cut short)`;
  return link ? `${text}\n\n---\nOpened from a Friday session: ${link}` : text;
}
