import { answerAsk, askPrompt, askTool, badCitations, citationsIn, cleanPage, newAskId, strikeBad, unDraw, type DeepDives, type Dive, type DiveHost } from "./deep-dive.js";
import { repoKeyOf } from "./repo-key.js";
import type { EngineTool } from "./types.js";

/**
 * "Ask the codebase" from the IDE (Arun, 2026-11-19, wave 2: "a question about how the code works, answered with the exact lines,
 * from inside the IDE"). It is Deep Dive's own ask, not another: a repo that has a Deep Dive answers through it (answerAsk: the
 * pages say where to look first, every citation is checked against the code, and the question is kept on the Deep Dive's page
 * too). A repo with none is answered the same way without the pages, by the person's coding tool in the folder, read-only.
 *
 * Kept in memory only: the IDE's tab polls for it a few times and shows it, and a Deep Dive's answers are kept by the Deep Dive.
 */

export interface CodeQuestion {
  id: string;
  folder: string;
  question: string;
  /** The lines selected in the editor when it was asked, if any. */
  about?: { path: string; from: number; to: number };
  status: "asking" | "done" | "failed";
  answer: string;
  /** The citations that hold (struck ones are left out), once each, for the chips. */
  cites: { file: string; start: number; end: number }[];
  bad: string[];
  error?: string;
  /** Whether this folder's repo has a Deep Dive (ready to answer, being written, or none), as it was when asked. */
  dive: DiveState;
  /** Where the answer came from: a Deep Dive of this repo, or the coding tool reading the folder. */
  source: "dive" | "tool";
  /** The Deep Dive's name, or the tool that answered. */
  from?: string;
  tool?: EngineTool;
  at: number;
}

const KEPT = 60;
const kept = new Map<string, CodeQuestion>();
const keep = (q: CodeQuestion): CodeQuestion => {
  kept.delete(q.id);
  kept.set(q.id, q);
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) break;
    kept.delete(old);
  }
  return q;
};
/** A repo's Deep Dive as the IDE's folder sees it: ready to answer from, being written, or none worth the name. */
export type DiveState = "ready" | "building" | "none";
/** A build that stopped with the server that ran it is not building (app.ts /api/deepdive `settled` says the same, at the same age). */
const STALE_BUILD_MS = 25 * 60_000;

/**
 * This folder's repo's Deep Dive, found as the build route finds it (the folder's remote through repoKeyOf, so a worktree or a
 * second checkout of the repo is the same one), and only a ready one answers (or a stopped one that has pages).
 */
export async function diveOf(dives: DeepDives, host: DiveHost, folder: string): Promise<{ state: DiveState; dive?: Dive }> {
  try {
    const f = ((await host("describe", { path: folder }, 30_000)) as { folder: { path: string; remote?: string } }).folder;
    const repo = repoKeyOf(f.remote ? { url: f.remote } : null, f.path);
    const dive = repo ? await dives.get(repo.key) : null;
    if (!dive) return { state: "none" };
    if (dive.status === "ready") return { state: "ready", dive };
    const building = dive.status === "building" && Date.now() - dive.at < STALE_BUILD_MS;
    if (building) return { state: "building" };
    // Failed, or left building by a quit: its pages, if some were written, still say where to look.
    return (await dives.pages(dive.key)).some((p) => p.status === "done") ? { state: "ready", dive } : { state: "none" };
  } catch {
    return { state: "none" };
  }
}

export const questionById = (id: string): CodeQuestion | null => kept.get(id) ?? null;

/** A folder compared as the IDE's are: one slash style, no trailing slash, any case on a Windows drive. */
export const dirKey = (p: string): string => {
  const f = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(f) ? f.toLowerCase() : f;
};

/** The tools that can answer, in the order Deep Dive prefers them. */
const ORDER: EngineTool[] = ["claude", "codex", "cursor", "devin", "opencode"];

/** What the selection says to the tool: where it is, and the code. */
export function aboutText(sel: { path: string; from: number; to: number; text: string } | null): string {
  if (!sel?.path || !sel.text.trim()) return "";
  const where = sel.from === sel.to ? `${sel.path}:${sel.from}` : `${sel.path}:${sel.from}-${sel.to}`;
  return `They have these lines open in the editor, and the question may be about them (\`${where}\`):\n\`\`\`\n${sel.text.replace(/\n+$/, "").slice(0, 6000)}\n\`\`\``;
}

const uniqueCites = (answer: string) => {
  const seen = new Set<string>();
  return citationsIn(answer).flatMap((c) => (seen.has(c.raw) ? [] : (seen.add(c.raw), [{ file: c.file, start: c.start, end: c.end }])));
};

/** A tool that ran out of time is not tried again by another: the next would take as long. */
const TIMED_OUT = /timed? ?out|timeout/i;

/**
 * Starts the question and returns it at once, asking; the answer arrives in the same record (questionById).
 * `host` reaches the computer the folder is on (app.ts diveHost). `tool` is the one the column is using, asked first; `by` is who asked.
 */
export async function startQuestion(o: {
  dives: DeepDives;
  host: DiveHost;
  folder: string;
  question: string;
  selection?: { path: string; from: number; to: number; text: string } | null;
  tool?: EngineTool | null;
  by?: string;
}): Promise<CodeQuestion> {
  const { dives, host, folder, question } = o;
  const about = aboutText(o.selection ?? null);
  const found = await diveOf(dives, host, folder);
  const base: CodeQuestion = {
    id: newAskId(),
    folder,
    question,
    ...(o.selection?.path ? { about: { path: o.selection.path, from: o.selection.from, to: o.selection.to } } : {}),
    status: "asking",
    answer: "",
    cites: [],
    bad: [],
    dive: found.state,
    source: "tool",
    at: Date.now(),
  };
  const viaTool = (q: CodeQuestion) =>
    void answerWithTool(host, folder, question, about, o.tool ?? null).then(
      (r) => keep({ ...q, status: "done", ...r, at: Date.now() }),
      (e: Error) => keep({ ...q, status: "failed", error: e.message.slice(0, 300), at: Date.now() }),
    );
  const dive = found.dive;
  if (dive) {
    // Kept on the Deep Dive's page with the lines it was about, which that page can't see (a bare "What is this for?" reads as nonsense there).
    const where = o.selection?.path && o.selection.text.trim() ? ` (${o.selection.path}:${o.selection.from === o.selection.to ? o.selection.from : `${o.selection.from}-${o.selection.to}`})` : "";
    const ask = { id: newAskId(), question: question + where, answer: "", bad: [], by: o.by ?? dive.by, at: Date.now(), status: "asking" as const };
    await dives.saveAsk(dive.key, ask);
    const q = keep({ ...base, source: "dive", from: dive.name, tool: dive.tool });
    // Read in the IDE's own folder, so the lines it cites are the ones in the checkout that is open.
    void answerAsk(dives, host, { ...dive, folder }, ask, about).then(async () => {
      const done = (await dives.asks(dive.key)).find((a) => a.id === ask.id);
      // Deleted on the Deep Dive's page while it was being answered: nothing to show.
      if (!done) return void keep({ ...q, status: "failed", error: "That question was deleted.", at: Date.now() });
      // The Deep Dive's own tool couldn't answer (signed out, out of usage): another one that can run reads the folder instead.
      if (done.status !== "done" && !TIMED_OUT.test(done.error ?? "")) {
        await dives.removeAsk(dive.key, ask.id).catch(() => false);
        return viaTool({ ...q, source: "tool", from: undefined, tool: undefined });
      }
      keep({ ...q, status: done.status === "asking" ? "failed" : done.status, answer: done.answer, bad: done.bad, cites: uniqueCites(done.answer), ...(done.error ? { error: done.error } : {}), at: Date.now() });
    });
    return q;
  }
  const q = keep(base);
  viaTool(q);
  return q;
}

/**
 * No Deep Dive: a tool that can run here reads the folder (plan mode: it changes nothing), as Deep Dive's own ask does. The one the
 * person is using goes first, then the others in Deep Dive's order; one that fails (out of usage, its sign-in not what it seemed) is
 * followed by the next, and only a tool out of time ends it.
 */
async function answerWithTool(host: DiveHost, folder: string, question: string, about: string, prefer: EngineTool | null): Promise<Pick<CodeQuestion, "answer" | "bad" | "cites" | "tool" | "from">> {
  const listed = (await host("tools", {}, 30_000)) as { tools?: { tool: EngineTool; name?: string; path: string | null; loggedIn: boolean | null; unavailable?: string }[] };
  const rank = (t: EngineTool) => (t === prefer ? -1 : ORDER.indexOf(t) < 0 ? 99 : ORDER.indexOf(t));
  const usable = (listed.tools ?? []).filter((t) => t.path && t.loggedIn !== false && !t.unavailable).sort((a, b) => rank(a.tool) - rank(b.tool));
  if (!usable.length) throw new Error("No coding tool on this computer is signed in to answer with.");
  const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
  let last: Error = new Error("No coding tool could answer.");
  for (const tool of usable) {
    try {
      const d: Pick<Dive, "folder" | "tool" | "model"> = { folder, tool: tool.tool };
      const r = await askTool(host, d, askPrompt(question, [], "", name, about));
      const text = cleanPage(r.text);
      const cites = citationsIn(text);
      const counts = cites.length ? ((await host("dive.lines", { path: folder, files: cites.map((c) => c.file) }, 60_000)) as { counts: Record<string, number | null> }).counts : {};
      const bad = badCitations(cites, counts);
      const answer = unDraw(strikeBad(text, bad));
      return { answer, bad, cites: uniqueCites(answer), tool: tool.tool, from: tool.name ?? tool.tool };
    } catch (e) {
      last = e as Error;
      if (TIMED_OUT.test(last.message)) break;
    }
  }
  throw last;
}
