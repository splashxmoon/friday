import { hostApi } from "../local.js";
import { kgPath } from "../crew-carry-open.js";
import { api } from "../api.js";
import type { Identity } from "../storage.js";
import type { CodeChat } from "./code-chats.js";

/**
 * The hand-off packet of a Code chat, written once and used by both ways a chat leaves Code: Send to Agents (send-to-agents.tsx)
 * and Hand to a teammate (hand-to-mate.tsx). Arun, 2026-11-20 (wave 5): "a Code chat's task goes to one of your Crew teammates
 * with the hand-off packet: the ask, what's done, the branch, changed files, open questions, the repo's rules and memory."
 * Plain words that the next one reads cold: whoever takes it was not in the chat.
 */
export interface PacketFacts {
  /** What was asked: the chat's title. */
  title: string;
  folder: string;
  /** How it stands, in the task board's words ("working", "PR #12 open", "asks: which port?"). */
  state?: string;
  branch?: string;
  files?: { path: string; add: number; del: number }[];
  /** How many things the session still lists as open, and decisions it made (the lists themselves go in the session's own note). */
  open?: number;
  decided?: number;
  /** The question the agent waits on. */
  question?: string;
  /** What the session says comes next. */
  next?: string;
  /** The repo's rules that are on. */
  rules?: string[];
}

const folderName = (f: string) => f.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || f;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/**
 * A path as it reads from the folder; one outside it (a lane working in its own worktree copy) as its last three parts, so a long
 * absolute one stays readable. Compared without case, as code-chats' key() does: C:\\ and c:\\ are one drive.
 */
export const shortPath = (p: string, root: string) => {
  const flat = p.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base && flat.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return flat.slice(base.length + 1);
  const parts = flat.split("/").filter(Boolean);
  return /^(?:[a-z]:)?\//i.test(flat) && parts.length > 3 ? parts.slice(-3).join("/") : flat;
};

/**
 * The facts as sections, each only when there is something to say. `carried`: the hand-off itself (crew-carry.ts) already puts the
 * branch, the session's own notes (what is open, decided, next) in the message, so they are not said twice.
 */
export function packetSections(f: PacketFacts, o: { carried?: boolean } = {}): string[] {
  const out: string[] = [];
  out.push(`What was asked: ${clip(f.title || "Untitled", 200)}`);
  if (f.state) out.push(`How it stands: ${f.state}`);
  if (f.branch && !o.carried) out.push(`Branch: ${f.branch}`);
  const files = f.files ?? [];
  if (files.length) {
    const add = files.reduce((n, x) => n + (x.add || 0), 0);
    const del = files.reduce((n, x) => n + (x.del || 0), 0);
    const list = files.slice(0, 12).map((x) => `- ${shortPath(x.path, f.folder)} (+${x.add || 0} -${x.del || 0})`);
    out.push(`Changed files (${plural(files.length, "file")}, +${add} -${del}):\n${list.join("\n")}${files.length > 12 ? `\n…and ${files.length - 12} more` : ""}`);
  }
  if (f.open && !o.carried) out.push(`Still open: ${plural(f.open, "thing")}${f.decided ? `; ${plural(f.decided, "decision")} made along the way` : ""} (the notes from the session list them).`);
  if (f.question) out.push(`The open question, still unanswered: ${clip(f.question, 400)}`);
  if (f.next && !o.carried) out.push(`Next step: ${clip(f.next, 400)}`);
  const rules = (f.rules ?? []).filter(Boolean);
  if (rules.length) out.push(`Rules for this repo (the people here asked for these; follow them, and say so if one stops you):\n${rules.slice(0, 30).map((r) => `- ${clip(r, 300)}`).join("\n")}`);
  return out;
}

/**
 * The note that goes to the one taking it. For Agents the session's own agent has the whole chat already, so it is asked to write
 * the hand-off down in a few lines; for a teammate, who has none of it, the facts are written out and it carries on from there.
 */
export function buildPacket(f: PacketFacts, to: { kind: "agents" } | { kind: "mate"; name: string }): string {
  const where = folderName(f.folder);
  if (to.kind === "agents") {
    const head = `Moved from Code to Agents: “${f.title || "Untitled"}” (in ${where}).`;
    // Its own agent has the session, the rules and the changes already: the original line, and at most the branch and how many
    // files, so the chat does not fill with what that agent knows.
    const files = f.files ?? [];
    const size = files.length ? `${plural(files.length, "file")} changed (+${files.reduce((n, x) => n + (x.add || 0), 0)} -${files.reduce((n, x) => n + (x.del || 0), 0)})` : "";
    const facts = [f.branch ? `on ${f.branch}` : "", size].filter(Boolean).join(", ");
    return [
      head,
      ...(facts ? [`It stands ${facts}.`] : []),
      "Add a short hand-off to your next reply: what was asked, what is done (branch, files), what is still open, and the next step. Then carry on with what you were doing.",
    ].join("\n\n");
  }
  return [
    `Handed from Code to ${to.name}: “${f.title || "Untitled"}” (in ${where}). Everything you need to carry on is here.`,
    ...packetSections(f, { carried: true }),
    // The repo's memory is not copied in: this teammate's run is briefed from it on its own (app.ts briefFor reads it by the repo's
    // key, and a copy of the folder, "<name>-<id>", has the same key: test/handoff-packet.test.ts), as it is for any run here.
    "Whatever Friday has learned about this repo (its project memory) is given to you with your first run, as it is for any run here.",
    "Carry on from here, on your own copy of the branch. When you finish, say what you did, which files changed, and what is still open.",
  ].join("\n\n");
}

/** The words Send to Agents has always sent, from nothing but the chat's title and folder. */
export const handoffText = (c: Pick<CodeChat, "title" | "folder">): string => buildPacket({ title: c.title, folder: c.folder }, { kind: "agents" });

interface SheetRead {
  title?: string;
  branch?: string;
  note?: string;
  carry?: { open?: number; decided?: number; question?: string };
}
interface TaskRead {
  sid: string;
  detail?: string;
  status?: string;
  files?: { path: string; add: number; del: number }[];
}

/**
 * What the session and the repo say now, read for the packet. Each read stands alone: one that fails leaves its part out, never
 * the whole hand-off (a chat with no changes, a folder with no rules, a session the sheet can't be read for).
 */
/** A read that takes longer than this is left out: a hand-off never waits on a slow part of its own note. */
const READ_MS = 4000;
const soon = <T>(p: Promise<T>): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), READ_MS))]);

/** A rule goes to the one taking it when it is on and is for its tool (rulesNote does the same for a run). */
const ruleFor = (r: { on?: boolean; tools?: string }, tool?: string) => {
  if (r.on === false) return false;
  const t = (r.tools || "all").toLowerCase();
  return !tool || t === "all" || t.split(",").map((x) => x.trim()).includes(tool.toLowerCase());
};

/** `rulesFor`: the tool of the one taking it, for the rules to keep; false for Agents' own agent, which has the rules already (no read). */
export async function gatherFacts(identity: Identity, chat: Pick<CodeChat, "sid" | "invite" | "title" | "folder">, o: { rulesFor?: string | false } = {}): Promise<PacketFacts> {
  const [sheet, tasks, rules] = await Promise.all([
    soon(api<SheetRead>(identity, kgPath(chat.sid, chat.invite))),
    soon(api<{ tasks?: TaskRead[] }>(identity, "/api/vscode/tasks")),
    o.rulesFor === false ? null : soon(hostApi<{ rules?: { text: string; on?: boolean; tools?: string }[] }>(identity, `/api/runner/rules.read?cwd=${encodeURIComponent(chat.folder)}`)),
  ]);
  const t = tasks?.tasks?.find((x) => x.sid === chat.sid);
  return {
    title: sheet?.title && sheet.title !== "This session" ? sheet.title : chat.title,
    folder: chat.folder,
    ...(t?.detail ? { state: t.detail } : t?.status === "done" ? { state: "done for now" } : {}),
    ...(sheet?.branch ? { branch: sheet.branch } : {}),
    ...(t?.files?.length ? { files: t.files.map((x) => ({ path: x.path, add: x.add, del: x.del })) } : {}),
    ...(sheet?.carry?.open ? { open: sheet.carry.open } : {}),
    ...(sheet?.carry?.decided ? { decided: sheet.carry.decided } : {}),
    ...(sheet?.carry?.question ? { question: sheet.carry.question } : {}),
    ...(sheet?.note ? { next: sheet.note } : {}),
    rules: (rules?.rules ?? []).filter((r) => ruleFor(r, o.rulesFor || undefined)).map((r) => r.text),
  };
}
