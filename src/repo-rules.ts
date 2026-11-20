/**
 * Rules that stick: what a repo's people have told the agents once ("we use pnpm", "no default exports"), kept in
 * .friday/rules.md at the repo root so every coding tool follows it and the team gets it with the repo (Arun, 2026-11-19: "correct
 * the agent once ... and it becomes a rule every tool follows. Editable in a 'Rules' view.").
 *
 * The file is a markdown list people can read and edit by hand:
 *   - [x] Use pnpm, never npm or yarn  <!-- from: Fix refunds.spec.ts, at: 2026-11-19, tools: all -->
 * [ ] is off. Lines that aren't rules (a heading, a note) are kept as they are. The IDE's extension keeps a twin of this
 * parser (src/vscode-ext/friday/rules.js: it is plain CommonJS and can't import this); test/repo-rules.test.ts holds them to
 * the same answers.
 */
export interface Rule {
  text: string;
  on: boolean;
  /** Where it came from: "you", a chat's name, "review of PR #412". */
  from: string;
  /** The day it was saved, YYYY-MM-DD. */
  at: string;
  /** "all", or the tools it is for, comma separated (claude, codex, ...). */
  tools: string;
}

export const RULES_FILE = ".friday/rules.md";
export const RULES_HEAD = "# Rules for this repo\n\nFriday tells every coding tool these before it starts. Turn one off with [ ], or edit the text.\n";

const LINE = /^()[-*]\s+\[([ xX])\]\s+(.*?)\s*$/;
const META = /\s*<!--\s*(.*?)\s*-->\s*$/;

// A comment's brackets can't sit in a rule's text or its source (they'd end the comment early); the commas in a source are what splits
// its fields, so a chat named "x, at: 2020-01-01" can't pose as a date or a tool list.
const clean = (s: string) => s.replace(/<!--/g, "<!-").replace(/-->/g, "->").replace(/\s+/g, " ").trim();
const source = (s: string) => clean(s).replace(/\s*,\s*/g, "; ");

function parseLine(line: string): Rule | null {
  const m = LINE.exec(line);
  if (!m) return null;
  let text = m[3];
  let from = "";
  let at = "";
  let tools = "all";
  const meta = META.exec(text);
  if (meta) {
    text = text.slice(0, meta.index).trim();
    const k = /^from:\s*(.*?)\s*(?:,\s*at:\s*(\S*?))?\s*(?:,\s*tools:\s*(.*?))?$/.exec(meta[1]);
    if (k) {
      from = k[1] ?? "";
      at = k[2] ?? "";
      tools = k[3]?.trim() || "all";
    }
  }
  if (!text) return null;
  return { text, on: m[2] !== " ", from, at, tools };
}

export function formatRule(r: Rule): string {
  const meta = `<!-- from: ${source(r.from) || "you"}, at: ${r.at || today()}, tools: ${clean(r.tools).replace(/\s*,\s*/g, ",") || "all"} -->`;
  return `- [${r.on ? "x" : " "}] ${clean(r.text)}  ${meta}`;
}

/** Today as the person has it (their clock, not UTC's: an evening save is not tomorrow's). */
export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The rules in a file's text, in order. */
export function parseRules(text: string): Rule[] {
  return text.split(/\r?\n/).map(parseLine).filter((r): r is Rule => !!r);
}

/** Changes the nth rule line (counting rules only); null drops it. The rest of the file is untouched. */
function mapNth(text: string, n: number, fn: (r: Rule, line: string) => Rule | string | null): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let i = -1;
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const r = parseLine(line);
    if (!r || ++i !== n) {
      out.push(line);
      continue;
    }
    const next = fn(r, line);
    if (typeof next === "string") out.push(next);
    else if (next) out.push(formatRule(next));
  }
  return out.join(eol);
}

// Only the box changes: a hand-written line keeps its own comment, wording and spacing.
export const setRuleOn = (text: string, n: number, on: boolean) => mapNth(text, n, (r, line) => (r.on === on ? line : line.replace(/\[[ xX]\]/, on ? "[x]" : "[ ]")));
export const editRule = (text: string, n: number, body: string) => mapNth(text, n, (r) => (clean(body) ? { ...r, text: clean(body) } : r));
export const removeRule = (text: string, n: number) => mapNth(text, n, () => null);

/** A rule added at the end; a file with none yet gets its heading. The same text twice is added once. */
export function addRule(text: string, r: Partial<Rule> & { text: string }): string {
  const rule: Rule = { text: clean(r.text), on: r.on ?? true, from: r.from ?? "you", at: r.at ?? today(), tools: r.tools ?? "all" };
  if (!rule.text) return text;
  if (parseRules(text).some((x) => x.text.toLowerCase() === rule.text.toLowerCase())) return text;
  const base = text.trim() ? text.replace(/\s*$/, "\n") : `${RULES_HEAD}\n`;
  return `${base}${formatRule(rule)}\n`;
}

/**
 * What a tool is told: the rules that are on and are for it, short and labelled. Nothing when there are none.
 */
export function rulesNote(text: string, tool?: string): string {
  const mine = parseRules(text).filter((r) => {
    if (!r.on) return false;
    const t = r.tools.toLowerCase();
    return !tool || t === "all" || t.split(",").map((x) => x.trim()).includes(tool);
  });
  if (!mine.length) return "";
  return `Rules for this repo (the people here asked for these; follow them in everything you do, and say so if one stops you):\n${mine.map((r) => `- ${r.text}`).join("\n")}`;
}

const LEAD = /^(?:(?:actually|ok|okay|hey|so|and|also|please|note that|remember(?: that)?|from now on|in this repo|for future reference|no(?=,))[,:]?\s+)+/i;
// What a convention is about: a thing to do or not do, in the present. A short list on purpose: "I don't understand", "we never got the
// email working" and "don't push yet" must not become rules (a wrong offer is a card to dismiss, but a flood of them is noise).
const VERB =
  "use|run|write|add|import|export|commit|push|merge|mock|name|put|call|rely|depend|touch|modify|edit|create|publish|log|hardcode|delete|remove|skip|force|format|lint|test|check|ask|keep|pin|install|leave|store|wrap|return|throw|catch|await|declare|bypass|disable|enable|inline|nest|copy|rename|bump|tag|squash|rebase|amend|type|annotate|document|handle|validate|sanitize|build|deploy|release|pull|open|ignore|upgrade|migrate|split|combine|reach|share|track";
const DET = "the|a|an|this|that|these|those|my|your|his|her|their|our|its|it|same|there|here|so|just|to|up|on|in|at|for|with|not|more|less|any|all|some|one|two|first|second|last|next|what|how|why|when|where|who";
const FORMS: RegExp[] = [
  new RegExp(`^we\\s+(?:use|prefer|avoid)\\s+(?!(?:${DET})\\b)\\S`, "i"),
  new RegExp(`^(?:i|we)\\s+prefer\\s+(?!(?:${DET})\\b)\\S`, "i"),
  new RegExp(`^we\\s+(?:always|never|only)\\s+(?:${VERB})\\b`, "i"),
  new RegExp(`^we\\s+(?:don'?t|do not)\\s+(?:${VERB})\\b`, "i"),
  new RegExp(`^(?:never|always)\\s+(?:${VERB})\\b`, "i"),
  new RegExp(`^avoid\\s+(?!(?:${DET})\\b)\\S`, "i"),
  new RegExp(`^(?:don'?t|do not|dont)\\s+(?:${VERB})\\b`, "i"),
];
// A one-off ("don't push yet", "don't commit this", "leave everything else") is an instruction for now, not a convention.
const ONE_OFF = /\b(?:yet|again|now|today|anymore|it)\b|\b(?:this|that|these|those)\b(?!\s+(?:repo|repository|project|codebase|folder|directory|app)\b)|\b(?:anything|everything|something) else\b/i;
const NOT_A_RULE = /\b(?:never mind|don'?t worry|do not worry|always works|doesn'?t work)\b/i;
// A message that is only "no <thing>": "no default exports".
const NO_THING = /^no\s+(?!(?:problem|problems|thanks|thank|worries|idea|way|need|more|longer|one|rush|luck|matter|sorry|please|not|i|you|we|they|that|this|it|go|stop|wait)\b)[a-z][\w./-]*(?:\s+[a-z][\w./-]*){0,3}$/i;

/**
 * A convention a person's message states ("we use pnpm, not npm", "never X", "always Y", "don't use default exports", "no default
 * exports"): the rule as a short sentence, or null. Kept narrow on purpose (see VERB, ONE_OFF).
 */
export function detectRule(message: string): string | null {
  if (message.length > 600) return null;
  const sentences = message.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+|\n+/);
  for (const raw of sentences) {
    let s = raw.trim().replace(/[.!\s]+$/, "");
    if (!s || s.endsWith("?") || NOT_A_RULE.test(s)) continue;
    s = s.replace(LEAD, "");
    const alone = sentences.length === 1 && s.length < 60 && NO_THING.test(s);
    if (!alone && (!FORMS.some((f) => f.test(s)) || ONE_OFF.test(s))) continue;
    s = s.replace(/^we\s+/i, "").replace(/^i\s+/i, "");
    if (s.length < 8 || s.length > 160 || s.split(" ").length < 2) continue;
    return s[0].toUpperCase() + s.slice(1);
  }
  return null;
}
