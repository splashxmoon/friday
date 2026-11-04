import type { DiffFile } from "./types.js";

/**
 * Rules that stick (Arun, 2026-11-03, of the shortlist: "Rules that stick"; docs/plans/dev-essentials.md §2).
 *
 * Telling an agent "use pnpm, not npm" works for that turn. A rule is the correction kept for the repo and checked on every
 * change, by every agent, in every session and teammate working there: a command that has to pass (brain.ts checks, as before),
 * or one of three things read straight off the change, with nothing run: a pattern no line it adds may match, a pattern no
 * command the agent ran may match, or files no change may touch. A breach goes back to the agent with the exact lines.
 *
 * The pure parts: what a rule says in words, which lines, commands or files break it, simple globs, and drafting a rule from a
 * person's own correction when the words make it plain. No I/O here.
 */

/** How a rule is checked. `command`: it has to pass in the agent's folder. The rest are read off the change itself. */
export type RuleHow = "command" | "lines" | "runs" | "paths";

export interface RuleCheck {
  how: Exclude<RuleHow, "command">;
  /** `lines`, `runs`: a regular expression. `paths`: globs, comma-separated. */
  pattern: string;
  /** For `lines`: only files matching these globs; and never files matching `except`. */
  only?: string[];
  except?: string[];
}

export interface Breach {
  /** Where: "src/a.ts:12", a command, or a file. */
  where: string;
  /** What: the line, the command, or how the file was changed. */
  what: string;
}

const MAX_PATTERN = 200;
const MAX_LINE = 1000;

/** A rule's pattern as a regular expression, or null when it isn't one (or is too long to trust). */
export function ruleRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > MAX_PATTERN) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * A glob as people write them: `*` within a folder, `**` across folders, `?` one character, a trailing `/` everything under it.
 * One with no `/` in it matches a file's name wherever it is ("*.test.ts").
 */
export function globMatch(glob: string, file: string): boolean {
  let g = glob.trim().replace(/^\.\//, "");
  if (!g) return false;
  if (g.endsWith("/")) g += "**";
  const f = file.replace(/\\/g, "/").replace(/^\.\//, "");
  const re = new RegExp(
    `^${g
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map((p) => (p === "**/" ? "(?:.*/)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p === "?" ? "[^/]" : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
      .join("")}$`,
  );
  // A folder named without its slash ("db/migrations") is everything under it too.
  return re.test(f) || (!g.includes("/") && re.test(f.split("/").pop() ?? f)) || (!/[*?]/.test(g) && f.startsWith(`${g.replace(/\/$/, "")}/`));
}

export const globsOf = (s: string): string[] =>
  s
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 20);

/** Which files a `lines` rule reads. */
const inScope = (r: Pick<RuleCheck, "only" | "except">, file: string) => (!r.only?.length || r.only.some((g) => globMatch(g, file))) && !r.except?.some((g) => globMatch(g, file));

/** The lines a patch adds, each with its line number in the new file. */
export function addedLines(patch: string): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = [];
  let n = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      n = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")) continue;
    if (line.startsWith("+")) out.push({ n: n++, text: line.slice(1) });
    else if (!line.startsWith("-")) n++;
  }
  return out;
}

/**
 * What in a change breaks the rule: the lines it adds that match (in the files it reads), the commands the agent ran that match,
 * or the files it touched that it may not. Empty when the rule holds, or can't be read (a pattern that isn't one breaks nothing).
 */
export function breaches(r: RuleCheck, files: readonly Pick<DiffFile, "path" | "status" | "patch">[], commands: readonly string[]): Breach[] {
  if (r.how === "paths") {
    const globs = globsOf(r.pattern);
    return files.filter((f) => globs.some((g) => globMatch(g, f.path))).map((f) => ({ where: f.path, what: f.status === "deleted" ? "deleted" : f.status === "added" ? "added" : "changed" }));
  }
  const re = ruleRegex(r.pattern);
  if (!re) return [];
  if (r.how === "runs") return [...new Set(commands)].filter((c) => re.test(c.slice(0, MAX_LINE))).map((c) => ({ where: "a command it ran", what: c }));
  const out: Breach[] = [];
  for (const f of files) {
    if (f.status === "deleted" || !inScope(r, f.path)) continue;
    for (const l of addedLines(f.patch ?? "")) if (re.test(l.text.slice(0, MAX_LINE))) out.push({ where: `${f.path}:${l.n}`, what: l.text.trim().slice(0, 200) });
    if (out.length >= 40) break;
  }
  return out;
}

/** A rule as a person reads it: "No line a change adds may match `console\.log\(`", and where. */
export function ruleWords(r: RuleCheck): string {
  if (r.how === "paths") return `No change may touch ${globsOf(r.pattern).join(", ")}`;
  if (r.how === "runs") return `No command an agent runs may match ${r.pattern}`;
  const where = [r.only?.length ? `in ${r.only.join(", ")}` : "", r.except?.length ? `except ${r.except.join(", ")}` : ""].filter(Boolean).join(", ");
  return `No line a change adds may match ${r.pattern}${where ? ` (${where})` : ""}`;
}

/** What the agent is sent when a change breaks rules: each rule, then exactly where. */
export function breachText(found: { rule: string; check: RuleCheck; breaches: Breach[] }[]): string {
  const parts = found.map((f) => {
    const list = f.breaches.slice(0, 12).map((b) => `- ${b.where}: ${b.what}`).join("\n");
    return `Rule: ${f.rule}\n(${ruleWords(f.check)})\n${list}${f.breaches.length > 12 ? `\n…and ${f.breaches.length - 12} more` : ""}`;
  });
  return `[Friday] Your change breaks ${found.length === 1 ? "a rule" : `${found.length} rules`} this repo keeps, set after an agent was corrected for it before:\n\n${parts.join("\n\n")}\n\nPut it right, then end your turn with a short report. Friday checks again when you do.`;
}

// ── drafting a rule from a correction ───────────────────────────────────

/** The command-line tools a "use X, not Y" is about: the rule is on the commands an agent runs, not the code. */
const TOOLS = new Set(["npm", "npx", "yarn", "pnpm", "bun", "bunx", "pip", "pip3", "pipx", "poetry", "uv", "conda", "python", "python3", "node", "deno", "make", "docker", "podman", "cargo", "go", "gradle", "mvn", "brew", "jest", "vitest", "pytest", "tsc", "eslint", "prettier", "biome"]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unquote = (s: string) => s.replace(/^[`'"]+|[`'".,;:!?]+$/g, "");

/**
 * Whether what a person said reads as a standing rule rather than this turn's ask: "don't…", "never…", "always…", "use X not Y",
 * "stop…", "from now on…". Cheap, and only a gate: the rule itself is drafted from the words, or by a model.
 */
export const STANDING = /\b(?:don'?t|do not|never|always|stop|no more|from now on|every time|instead of|rather than|we use|we don'?t|avoid)\b|\buse \S+,? (?:not|over) \S+/i;

/**
 * A rule from a person's correction, when the words make it plain; null when they don't (a model may still draft one). Three
 * shapes people actually say:
 *
 * - "use pnpm, not npm" (a tool): no command the agent runs may start npm; (a package): no line may import it.
 * - "don't add console.log", "no debugger statements", "never use `any`": no added line may contain it.
 * - "never edit generated/", "don't touch the migrations folder at db/migrations": no change may touch it.
 */
export function draftRule(said: string): { rule: string; check: RuleCheck } | null {
  const text = said.replace(/\s+/g, " ").trim();
  if (text.length > 600) return null;
  let m = text.match(/\buse `?([\w.@/-]+)`?,? (?:and )?(?:not|instead of|rather than|over) `?([\w.@/-]+)`?/i);
  if (m) {
    const [, want, not] = m.map(unquote) as [string, string, string];
    if (!want || !not || want.toLowerCase() === not.toLowerCase()) return null;
    if (TOOLS.has(not.toLowerCase())) return { rule: `Use ${want}, not ${not}.`, check: { how: "runs", pattern: `(?:^|[\\s;&|(])${esc(not)}(?=\\s|$)` } };
    return { rule: `Use ${want}, not ${not}.`, check: { how: "lines", pattern: `['"]${esc(not)}(?:['"/])` } };
  }
  m = text.match(/\b(?:never|don'?t|do not|stop) (?:edit(?:ing)?|touch(?:ing)?|chang(?:e|ing)|modify(?:ing)?|writ(?:e|ing) (?:to|in)) (?:anything in |the )?`?([\w.*-]*\/[\w./*-]*|[\w-]+\.[\w]+)`?/i);
  if (m) {
    const path = unquote(m[1]!);
    if (path && path !== "/") return { rule: `Never change ${path}.`, check: { how: "paths", pattern: path.endsWith("/") || !/[.*]/.test(path.split("/").pop() ?? "") ? `${path.replace(/\/?$/, "/")}` : path } };
  }
  m = text.match(/\b(?:no(?: more)?|never|don'?t|do not|stop) (?:add(?:ing)?|us(?:e|ing)|leav(?:e|ing)|commit(?:ting)?|writ(?:e|ing)|put(?:ting)?|ship(?:ping)?)? ?(?:any |in )?`([^`]{2,60})`/i) ?? text.match(/\b(?:no(?: more)?|never|don'?t|do not|stop) (?:add(?:ing)?|us(?:e|ing)|leav(?:e|ing)|commit(?:ting)?|writ(?:e|ing)|put(?:ting)?)? ?(?:any )?((?:[\w$]+\.)+[\w$]+(?:\(\))?|debugger|TODO|FIXME|\.only|print\(\))/i);
  if (m) {
    let token = unquote(m[1]!).replace(/\(\)$/, "(");
    // "console.logs": the plural of what is meant.
    if (/\.\w+s$/.test(token) && !/\.(?:js|ts|css|class|items|keys|values|entries|is|has|ss)$/i.test(token)) token = token.slice(0, -1);
    if (token.length < 2) return null;
    // TypeScript's `any` is the type, never the word in a comment or a string.
    const pattern = token === "any" ? String.raw`(?::\s*|<|\bas\s+)any\b` : /^\w/.test(token) && /\w$/.test(token) ? `\\b${esc(token)}\\b` : esc(token);
    return { rule: `No \`${token.replace(/\($/, "()")}\` in the code.`, check: { how: "lines", pattern } };
  }
  return null;
}

/** A rule a model drafted, as JSON, made safe: anything not in the shape asked for is no rule at all. */
export function parseDraft(raw: string): { rule: string; check: RuleCheck } | null {
  const from = raw.indexOf("{");
  const to = raw.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw.slice(from, to + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rule = typeof v.rule === "string" ? v.rule.trim().slice(0, 300) : "";
  const how = v.how === "lines" || v.how === "runs" || v.how === "paths" ? v.how : null;
  const pattern = typeof v.pattern === "string" ? v.pattern.trim() : "";
  if (!rule || !how || !pattern) return null;
  if (how !== "paths" && !ruleRegex(pattern)) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((g): g is string => typeof g === "string" && !!g.trim()).map((g) => g.trim()).slice(0, 10) : []);
  const only = list(v.only);
  const except = list(v.except);
  return { rule, check: { how, pattern, ...(only.length ? { only } : {}), ...(except.length ? { except } : {}) } };
}

/** What a model is asked when the words alone don't make a rule plain. */
export const DRAFT_SYSTEM = `A person working with coding agents on a repository just wrote the message below. Decide whether it states a standing rule for this repository (something every agent should always or never do here, from now on), not only this turn's request.

If it does, and the rule can be checked mechanically on a change, answer with only JSON: {"rule": "the rule in one short sentence", "how": "lines" | "runs" | "paths", "pattern": "...", "only": ["glob", ...], "except": ["glob", ...]}
- "lines": no line a change adds may match "pattern", a JavaScript regular expression; "only"/"except" narrow which files are read (globs like "src/**", "*.test.ts").
- "runs": no shell command an agent runs may match "pattern", a regular expression.
- "paths": no change may touch files matching "pattern", comma-separated globs ("generated/", "db/migrations/**").
Keep patterns tight enough not to catch harmless lines (word boundaries, the exact call). Leave "only"/"except" out when not needed.

If it is not a standing rule, or can't be checked that way, answer {}.`;
