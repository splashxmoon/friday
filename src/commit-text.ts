import type { SessionState } from "./session/projection.js";
import type { SessionEvent } from "./types.js";
import { plainCommitMessage } from "./pr-body.js";

/**
 * Commit messages in the repo's own voice (Arun, 2026-11-19, wave 3: "Commit messages and PR descriptions written from what the
 * agent did and why, in your repo's style"). Three small jobs, all plain text in and out so they can be tested without a model:
 *
 *   detectStyle   reads the last commits' subjects: conventional or plain, imperative or past, how long, capital letters, a period
 *   commitPrompt  what a coding tool is asked: the style said in words, the why, the diff
 *   plainMessage  the message when no tool is signed in: the files and the ask, set in the same style
 *
 * It only reads what is given. Nothing here runs git or calls a model.
 */

export interface CommitSample {
  subject: string;
  /** Whether the commit had more than a subject. */
  body?: boolean;
}

export interface CommitStyle {
  /** How many commits it was read from (merges and fixups left out). */
  from: number;
  conventional: boolean;
  /** The types the repo uses, most used first (feat, fix, docs…), when conventional. */
  types: string[];
  /** Subjects start with an area word that is not a conventional type, `core: fix x`, `ui: tidy y`. */
  prefixed: boolean;
  /** The area words the repo uses, most used first, when prefixed. */
  prefixes: string[];
  /** Conventional subjects carry a scope, `fix(auth):`. */
  scopes: boolean;
  /** "Add", "Added", "Adds": the first word of the subject. */
  tense: "imperative" | "past" | "present" | "other";
  /** Subjects start with a capital (after any `type:`). */
  capital: boolean;
  /** Subjects end with a period. */
  period: boolean;
  /** The longest a subject should run: the repo's own p90, within 50 to 72. */
  maxSubject: number;
  /** Most commits have a body under the subject. */
  bodies: boolean;
  /** A ticket id leads the subject, `PROJ-123 `. */
  ticket: boolean;
  /** A gitmoji or `:emoji:` leads the subject. */
  emoji: boolean;
}

const TYPES = ["feat", "fix", "docs", "chore", "refactor", "test", "tests", "perf", "style", "build", "ci", "revert", "deps", "release", "wip"];
const CONVENTIONAL = /^(\w+)(\(([^)]*)\))?(!)?:\s+(.*)$/;
const TICKET = /^\[?[A-Z][A-Z0-9]+-\d+\]?[:\s]/;
const EMOJI = /^(?:\p{Extended_Pictographic}|:[a-z0-9_+-]+:)/u;
/** Words that end in "ed" or "s" without being the past or present of a verb. */
const NOT_PAST = /^(need|feed|speed|seed|embed|proceed|succeed|exceed|shed|bed|red|bleed|breed|weed|reed|hundred|sacred|naked)$/i;
const PRESENT = /^(add|fix|updat|remov|chang|creat|renam|mov|us|mak|improv|refactor|bump|drop|set|handl|clean|support|allow|ensur|prevent|replac|implement|introduc|simplif|extract|delet|enabl|disabl|avoid|correct|tweak|polish|document|expos|pass|pick|show|hid|skip|stop|start|wrap|write|read|run|return|log|load|build|test|tighten|speed|reduc|sort|split|merg|sync|switch)(s|es)$/i;
const IRREGULAR_PAST = /^(made|ran|wrote|read|set|put|got|took|gave|built|split|hid|began|kept|left|sent|found|brought|fell|dropped|stopped|began)$/i;

/** The words after a `type(scope):` prefix, ticket or emoji, which is where the sentence starts. */
function sentenceOf(subject: string): string {
  let s = subject.trim();
  const c = s.match(CONVENTIONAL);
  if (c && (TYPES.includes(c[1]!.toLowerCase()) || /^[a-z]/.test(c[1]!))) s = c[5]!;
  s = s.replace(TICKET, "").replace(/^(?:\p{Extended_Pictographic}️?|:[a-z0-9_+-]+:)\s*/u, "");
  return s.trim();
}

function tenseOf(word: string): "imperative" | "past" | "present" | "other" {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "other";
  if (IRREGULAR_PAST.test(w) && !/^(set|read|split)$/.test(w)) return "past";
  if (/ed$/.test(w) && w.length > 3 && !NOT_PAST.test(w)) return "past";
  if (PRESENT.test(w)) return "present";
  if (/^[a-z]+$/.test(w)) return "imperative";
  return "other";
}

const skipped = (s: string) => /^(merge |revert "|fixup!|squash!|amend!|initial commit|wip\b)/i.test(s.trim()) || !s.trim();

/** The voice the repo writes its commits in, from its recent subjects. Few commits say little, so `from` tells how sure it is. */
export function detectStyle(samples: (CommitSample | string)[]): CommitStyle {
  const list = samples.map((x) => (typeof x === "string" ? { subject: x } : x)).filter((x) => !skipped(x.subject));
  const n = list.length;
  const share = (k: number) => (n ? k / n : 0);
  const conv = list.map((x) => x.subject.match(CONVENTIONAL)).map((m) => (m && TYPES.includes(m[1]!.toLowerCase()) ? m : null));
  const conventional = n >= 3 ? share(conv.filter(Boolean).length) >= 0.5 : conv.filter(Boolean).length === n && n > 0;
  const counts = new Map<string, number>();
  for (const m of conv) if (m) counts.set(m[1]!.toLowerCase(), (counts.get(m[1]!.toLowerCase()) ?? 0) + 1);
  // `core: fix x`: an area prefix outside the fixed types is still a prefix the repo writes, not the lack of one.
  const area = list.map((x) => x.subject.match(CONVENTIONAL)).map((m) => (m && !TYPES.includes(m[1]!.toLowerCase()) && /^[a-z]/.test(m[1]!) ? m : null));
  const areaN = area.filter(Boolean).length;
  const prefixed = !conventional && (n >= 3 ? share(areaN) >= 0.5 : areaN === n && n > 0);
  const areas = new Map<string, number>();
  for (const m of area) if (m) areas.set(m[1]!.toLowerCase(), (areas.get(m[1]!.toLowerCase()) ?? 0) + 1);
  const types = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const scoped = conv.filter((m) => m && m[3]).length;
  const sentences = list.map((x) => sentenceOf(x.subject)).filter(Boolean);
  const tenses = { imperative: 0, past: 0, present: 0, other: 0 };
  for (const s of sentences) tenses[tenseOf(s.split(/\s+/)[0] ?? "")]++;
  // One or two commits ("init") are not a voice: the usual habits stand until there are three to read.
  const sure = n >= 3;
  const best = (Object.entries(tenses) as ["imperative" | "past" | "present" | "other", number][]).sort((a, b) => b[1] - a[1])[0]!;
  // With nothing to read, the usual: imperative.
  const tense: CommitStyle["tense"] = sure && sentences.length && best[1] > 0 ? best[0] : "imperative";
  const lens = list.map((x) => x.subject.length).sort((a, b) => a - b);
  const p90 = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))]! : 72;
  return {
    from: n,
    conventional,
    types: conventional ? types : [],
    prefixed,
    prefixes: prefixed ? [...areas].sort((a, b) => b[1] - a[1]).map(([t]) => t) : [],
    scopes: conventional && conv.filter(Boolean).length > 0 && share(scoped) >= 0.3,
    tense,
    capital: sure && sentences.length ? sentences.filter((s) => /^[A-Z]/.test(s)).length / sentences.length >= 0.6 : true,
    period: sure && n ? list.filter((x) => /\.$/.test(x.subject.trim())).length / n >= 0.5 : false,
    maxSubject: Math.max(50, Math.min(72, p90)),
    bodies: n >= 3 ? share(list.filter((x) => x.body).length) >= 0.4 : false,
    ticket: n >= 3 && share(list.filter((x) => TICKET.test(x.subject.trim())).length) >= 0.5,
    emoji: n >= 3 && share(list.filter((x) => EMOJI.test(x.subject.trim())).length) >= 0.5,
  };
}

/** The style as the instructions a model is given: what to write, never a lecture. */
export function styleNote(s: CommitStyle): string {
  const out: string[] = [];
  if (!s.from) out.push("There is no history to copy: write a plain subject in the imperative mood, under 65 characters, no period.");
  else {
    if (s.conventional) out.push(`This repository uses conventional commits: the subject starts with a type${s.scopes ? " and a scope in brackets" : ""}, like ${s.types.slice(0, 4).map((t) => `${t}${s.scopes ? "(scope)" : ""}:`).join(" ")} (only these types: ${s.types.join(", ")}).`);
    else if (s.prefixed) out.push(`Subjects start with an area prefix, like ${s.prefixes.slice(0, 4).map((t) => `${t}:`).join(" ")} (not feat: or fix:): pick the area the change is in.`);
    else out.push("This repository does not use conventional-commit prefixes (no feat: or fix:).");
    const verb = { imperative: 'the imperative ("Add", "Fix")', past: 'the past tense ("Added", "Fixed")', present: 'the present tense ("Adds", "Fixes")', other: "the way the examples do" }[s.tense];
    out.push(`The sentence is in ${verb}, ${s.capital ? "starts with a capital" : "starts lower-case"}, ${s.period ? "ends with a period" : "has no period at the end"}, and the subject stays under ${s.maxSubject} characters.`);
    out.push(s.bodies ? "Commits here usually have a short body under the subject: say why, in a few lines." : "Commits here are usually a subject alone: add a body of one to three short lines only when the why is not obvious.");
    if (s.ticket) out.push("Subjects start with a ticket id (like PROJ-123): use one only if the ask or the branch names it, never invent one.");
    if (s.emoji) out.push("Subjects start with an emoji: do the same.");
  }
  return out.join(" ");
}

export interface Why {
  /** What the person asked for, in their words. */
  asked: string;
  /** What was decided on the way, one line each. */
  decisions: string[];
  /** What the agent said it did, its last plain answer. */
  did: string;
  /** The session's title. */
  title: string;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** What the person wrote themselves: a task started from an issue carries the issue's text after a rule. */
const own = (t: string) => t.split(/\n+---\n+GitHub (?:issue|pull request) #/)[0]!;

/** The why behind changes a session made: the ask since its last commit, the decisions written down, the agent's own closing words. */
export function sessionWhy(state: SessionState | null, events: SessionEvent[]): Why | null {
  if (!state) return null;
  const since = events.findLastIndex((e) => e.body.type === "folder.committed");
  const human = (e: SessionEvent) => e.body.type === "instruction" && e.actor.kind === "human";
  const first = events.slice(since + 1).find(human) ?? events.find(human);
  const asked = first && first.body.type === "instruction" ? clip(own(first.body.text), 500) : "";
  const decisions = new Map<string, string>();
  for (const e of events) if (e.body.type === "memory.saved") (e.body.text ? decisions.set(e.body.key, e.body.text) : decisions.delete(e.body.key));
  const last = [...events].reverse().find((e) => e.body.type === "agent.message" && !e.body.toolCalls.length && e.body.text);
  const did = last && last.body.type === "agent.message" ? clip(last.body.text, 500) : "";
  if (!asked && !did && !decisions.size) return null;
  return { asked, decisions: [...decisions].slice(-5).map(([k, v]) => `${clip(k, 60)}: ${clip(v, 160)}`), did, title: state.title || "" };
}

/**
 * Do these paths (from a session's diff, relative to its folder) include any of the ones the IDE says changed (relative to the
 * repo's root)? Exact paths only: `index.ts` at one root is not `packages/other/src/index.ts`. A chat opened on a folder inside
 * the repo passes that folder's path under the root as `prefix`, so its paths are read from the root.
 */
export function touches(session: string[], changed: string[], prefix = ""): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const pre = norm(prefix).replace(/^\/+|\/+$/g, "");
  const have = new Set(session.map((p) => (pre ? `${pre}/${norm(p)}` : norm(p))));
  return changed.some((p) => have.has(norm(p)));
}

export interface ChangedFile {
  path: string;
  status?: string;
}

export const COMMIT_SYSTEM =
  "You write git commit messages for a developer. Reply with the commit message only: no preamble, no code fences, no quotes around it, no sign-off. Everything you need is in the message you are given, so do not read files or run commands.";

/** The question put to a coding tool: the style, the why when a session made these changes, and the diff itself. */
export function commitPrompt(o: { style: CommitStyle; subjects: string[]; files: ChangedFile[]; diff: string; why: Why | null; staged: boolean }): string {
  const parts: string[] = [];
  parts.push(`Write the commit message for ${o.staged ? "the staged changes" : "all the changes"} below.`);
  parts.push(styleNote(o.style));
  const sample = o.subjects.filter((s) => !skipped(s)).slice(0, 8);
  if (sample.length) parts.push(`The last commits in this repository, newest first, to match in voice:\n${sample.map((s) => `- ${s}`).join("\n")}`);
  if (o.why) {
    const w = [o.why.asked && `They asked an agent: ${o.why.asked}`, o.why.did && `The agent said it did: ${o.why.did}`, o.why.decisions.length && `Decisions made on the way:\n${o.why.decisions.map((d) => `- ${d}`).join("\n")}`].filter(Boolean);
    parts.push(`Why this change was made (from the chat that made it; use it for the reason, not for the wording of the subject):\n${w.join("\n")}`);
  }
  parts.push(`Files:\n${o.files.slice(0, 60).map((f) => `- ${f.status ? `${f.status} ` : ""}${f.path}`).join("\n")}${o.files.length > 60 ? `\n- …and ${o.files.length - 60} more` : ""}`);
  const diff = fairDiff(o.diff, MAX_DIFF);
  parts.push(`The diff${diff.length < o.diff.length ? " (cut short)" : ""}:\n${diff}`);
  parts.push("Say what changed and why, never how the lines look. Output only the message.");
  return parts.join("\n\n");
}
export const MAX_DIFF = 16_000;

/** A diff cut to fit, with every file given its share (one big file can't leave the rest unseen), and each cut file said to be. */
export function fairDiff(diff: string, max: number): string {
  if (diff.length <= max) return diff;
  const per = diff.split(/^(?=diff --git )/m).filter(Boolean);
  const share = Math.max(400, Math.floor(max / Math.max(1, per.length)));
  // Small files give their unused room to the big ones.
  const small = per.filter((d) => d.length <= share);
  const room = per.length > small.length ? Math.floor((max - small.reduce((n, d) => n + d.length, 0)) / (per.length - small.length)) : share;
  const out: string[] = [];
  let left = max;
  for (const d of per) {
    const take = Math.min(left, d.length <= share ? d.length : Math.max(share, room));
    if (take <= 0) break;
    out.push(d.length > take ? `${d.slice(0, take).replace(/\n[^\n]*$/, "")}\n… (rest of this file's diff cut)\n` : d);
    left -= take;
  }
  return out.join("");
}

/** A model's answer made safe to drop in a commit box: the message alone, in the repo's period and length habits. */
export function cleanMessage(raw: string, style: CommitStyle): string {
  let t = raw.replace(/\r\n/g, "\n").trim();
  // A preamble, then a fence round the message: peeled until nothing more comes off, whichever order the model wrapped them in.
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/^(?:here(?:'s| is)[^\n]*:|commit message:?)\s*\n?/i, "").trim();
    t = t.replace(/^(?:```|~~~)\w*[ \t]*\n?/, "").replace(/\n?(?:```|~~~)\s*$/, "").trim();
    if (t === before) break;
  }
  if (/^(["'`]).*\1$/s.test(t) && !t.includes("\n\n")) t = t.slice(1, -1).trim();
  const lines = t.split("\n");
  let subject = (lines.shift() ?? "").trim();
  subject = subject.replace(/^(?:subject|title):\s*/i, "").replace(/^#{1,6}\s+/, "");
  // **feat: add x**, `feat: add x` and __feat: add x__: the marks are the model's, not the message's.
  subject = subject.replace(/^(\*\*|__|`)(.+)\1$/, "$2").trim();
  subject = style.period ? (/[.!?]$/.test(subject) ? subject : `${subject}.`) : subject.replace(/\.+$/, "");
  const body = lines.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trim();
  return (body ? `${subject}\n\n${body}` : subject).slice(0, 2000);
}

const VERBS = /^(add|fix|update|remove|change|create|rename|move|use|make|improve|refactor|bump|drop|set|handle|clean|support|allow|ensure|prevent|replace|implement|introduce|simplify|extract|delete|enable|disable|avoid|correct|tweak|polish|document|expose|show|hide|skip|stop|start|wrap|write|return|log|load|build|test|reduce|sort|split|merge|sync|switch)$/i;
const PAST_OF: Record<string, string> = { make: "made", write: "wrote", set: "set", hide: "hid", build: "built", split: "split", run: "ran" };
/** One short syllable ending in a single consonant doubles it before -ed: stop, drop, skip, log, wrap. */
const DOUBLES = /^[^aeiou]*[aeiou][^aeiouwxy]$/;
/** An imperative verb in the repo's tense; a word that is not one of the common verbs is left as it is. */
function inTense(word: string, tense: CommitStyle["tense"]): string {
  const w = word.toLowerCase();
  if (!VERBS.test(w) || tense === "imperative" || tense === "other") return word;
  if (tense === "past") return PAST_OF[w] ?? (/e$/.test(w) ? `${w}d` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ied` : DOUBLES.test(w) && w.length <= 4 ? `${w}${w.slice(-1)}ed` : `${w}ed`);
  return /(s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
}

/** The type a conventional subject would carry, from the files and the ask: only what they say. */
export function guessType(files: ChangedFile[], asked: string, types: string[]): string {
  const has = (t: string) => types.length === 0 || types.includes(t);
  const paths = files.map((f) => f.path.replace(/\\/g, "/"));
  const all = (re: RegExp) => paths.length > 0 && paths.every((p) => re.test(p));
  let t = "chore";
  if (all(/\.(md|mdx|txt|rst)$|(^|\/)docs?\//i)) t = "docs";
  else if (all(/(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.\w+$/i)) t = "test";
  else if (all(/(^|\/)\.github\/|(^|\/)(\.gitlab-ci|\.circleci|Jenkinsfile)/i)) t = "ci";
  else if (/\b(fix|bug|broken|crash|error|regression|wrong|fails?)\b/i.test(asked)) t = "fix";
  else if (/\b(refactor|clean ?up|rename|simplif|tidy|restructure)/i.test(asked)) t = "refactor";
  else if (all(/(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|go\.(mod|sum)|requirements.*\.txt|Dockerfile)$/)) t = "build";
  else if (/\b(add|new|implement|support|create|introduce|allow|let|enable)\b/i.test(asked)) t = "feat";
  if (!has(t)) t = has("chore") ? "chore" : types[0] ?? t;
  return t;
}

/** A sentence's first word lower-cased, unless it is an acronym or an identifier (API, iOS, parseJSON), which stay as written. */
function lowerFirst(sentence: string): string {
  const w = sentence.split(/\s+/)[0] ?? "";
  return /^[A-Z][a-z']*$/.test(w) ? w.toLowerCase() + sentence.slice(w.length) : sentence;
}

/** No model: the ask when it reads as a subject, else the files, set in the repo's style (prefix, tense, capital, period). */
export function plainMessage(files: ChangedFile[], asked: string, style: CommitStyle): string {
  const [first = "", ...rest] = plainCommitMessage(files, asked).split(/\s+/);
  let sentence = [inTense(first, style.tense), ...rest].join(" ");
  if (style.conventional) {
    const type = guessType(files, asked, style.types);
    // "fix: fix the crash" says it twice: the type is the verb.
    if (inTense(first, "imperative").toLowerCase() === type) sentence = rest.join(" ").replace(/^(?:the|a|an)\s+/i, "") || sentence;
    sentence = `${type}: ${lowerFirst(sentence)}`;
  } else if (style.prefixed) {
    const dir = (files[0]?.path ?? "").replace(/\\/g, "/").split("/")[0]!.toLowerCase();
    const area = files.length && files.every((f) => f.path.replace(/\\/g, "/").split("/")[0]!.toLowerCase() === dir) ? style.prefixes.find((p) => p === dir) : undefined;
    sentence = `${area ? `${area}: ` : ""}${area ? lowerFirst(sentence) : sentence}`;
  } else sentence = style.capital ? sentence.replace(/^./, (c) => c.toUpperCase()) : lowerFirst(sentence);
  return style.period ? `${sentence.replace(/\.+$/, "")}.` : sentence.replace(/\.+$/, "");
}

/** The plain message with a few lines of body from the session, when a chat made the changes and the repo writes bodies. */
export function plainWithWhy(files: ChangedFile[], style: CommitStyle, why: Why | null): string {
  const subject = plainMessage(files, why?.asked ?? "", style);
  const lines = style.bodies && why ? [why.did && clip(why.did, 200), ...why.decisions.slice(0, 3).map((d) => `- ${d}`)].filter(Boolean) : [];
  return lines.length ? `${subject}\n\n${lines.join("\n")}` : subject;
}
