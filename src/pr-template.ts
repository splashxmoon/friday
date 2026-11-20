import type { PrParts } from "./pr-body.js";

/**
 * A repo's own pull-request template, filled from the session (Arun, 2026-11-19, wave 3: "PR descriptions … in your repo's
 * style"). The template is the repo's voice: its headings stay, in its order. Each section the session has something true
 * to say about gets it (why, what changed, how it was checked, decisions); a checkbox is ticked only when the session can
 * vouch for it (the tests ran and passed); every other section keeps what the template says, comments removed. The session's
 * whole account follows, folded, so nothing prBodyFor wrote is lost.
 */

/** Where GitHub looks for the one template, in the order it does (a folder of several is not guessed between). */
export const TEMPLATE_PATHS = [".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE.md", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "docs/pull_request_template.md", "docs/PULL_REQUEST_TEMPLATE.md", ".gitlab/merge_request_templates/Default.md"];

type Kind = "checklist" | "tests" | "issue" | "why" | "decisions" | "summary" | "changes" | "open" | "other";

const kindOf = (heading: string, body: string): Kind => {
  const h = heading.toLowerCase();
  if (/\bchecklist\b|\bchecks?\b$|before (?:you )?(?:submit|merge|request)/.test(h) || (/^\s*[-*]\s*\[[ xX]\]/m.test(body) && !/test|verif/.test(h))) return "checklist";
  if (/\btest|verif|validat|how (?:was|has|to|did).*(?:tested|verified|checked)|qa\b/.test(h)) return "tests";
  if (/\b(related|linked)\b|issues?\b|ticket|closes|fixes|resolves/.test(h)) return "issue";
  if (/\bwhy\b|motivation|context|reason|background|problem|goal|purpose|rationale/.test(h)) return "why";
  if (/release|changelog/.test(h)) return "other";
  if (/decision|trade-?off|consideration|risk|caveat|notes? (?:for|to)|reviewer|follow-?ups?|not done|limitation/.test(h)) return "decisions";
  if (/\bchanges\b|what changed|changelog|files/.test(h) && !/summary|description/.test(h)) return "changes";
  if (/summary|description|what\b|overview|about|tl;?dr|proposed/.test(h)) return "summary";
  return "other";
};

const stripComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "");

/**
 * A checkbox the session can vouch for: it says, positively, that tests passed or ran, or were added, and they did. Never a bare
 * label ("Unit tests"), a negation ("No tests are needed"), or a place the agent did not run them ("pass on Windows", "in CI").
 */
const vouched = (item: string, p: PrParts): boolean => {
  const t = item.toLowerCase().replace(/\s+/g, " ");
  if (!/\btests?\b/.test(t)) return false;
  if (/\b(no|not|n\/a|none|without|skip|skipped|needed|need|require|required|unnecessary|breaking|manual|screenshots?)\b|n't/.test(t)) return false;
  // Another place or setup than the one the agent ran: not this session's to vouch for.
  if (/\b(windows|linux|mac|macos|ios|android|safari|firefox|chrome|browsers?|ci|staging|prod|production|cross-platform|e2e|integration|end-to-end|locally on|on (?:my|the) )\b/.test(t)) return false;
  const added = /\b(add|added|adds|write|wrote|written|new|cover|covered)\b/.test(t);
  const ran = /\b(pass|passes|passed|passing|ran|run|green|succeed|succeeds)\b/.test(t);
  if (added && !ran) return p.addedTests && p.tests === "pass";
  if (ran) return p.tests === "pass" && (!added || p.addedTests);
  return false;
};

const bullets = (l: string[]) => l.map((x) => `- ${x}`).join("\n");

/** The text a section is given, or "" when the session has nothing true for it. */
function textFor(kind: Kind, p: PrParts): string {
  if (kind === "issue") return p.why.split("\n").find((l) => /^Closes\s/.test(l)) ?? "";
  if (kind === "why") return p.why.split("\n").filter((l) => !/^Closes\s/.test(l)).join("\n").trim() || "";
  if (kind === "summary") return p.did || (p.changes.length ? bullets(p.changes) : "");
  if (kind === "changes") return p.changes.length ? bullets(p.changes) : "";
  if (kind === "tests") {
    if (p.tests === "none") return "";
    return `${p.tests === "pass" ? "The tests passed" : "The tests failed"}${p.testCmd ? ` (\`${p.testCmd.replace(/`/g, "'")}\`)` : ""}, run by the agent in this session.`;
  }
  if (kind === "decisions") return [p.decisions.length ? bullets(p.decisions) : "", p.notDone.length ? `Not done:\n${bullets(p.notDone)}` : ""].filter(Boolean).join("\n\n");
  return "";
}

/** Tick what holds; leave every other box and line as the template has it. */
function tick(body: string, p: PrParts): string {
  return body.replace(/^(\s*[-*]\s*)\[ \](\s+.*)$/gm, (all, lead: string, rest: string) => (vouched(rest, p) ? `${lead}[x]${rest}` : all));
}

export function fillPrTemplate(template: string, parts: PrParts, full: string): string {
  const src = stripComments(template.replace(/\r\n/g, "\n")).replace(/\n{3,}/g, "\n\n").trim();
  const lines = src.split("\n");
  const sections: { heading: string; body: string[] }[] = [{ heading: "", body: [] }];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && line.match(/^#{1,6}\s+(.*)$/);
    if (h) sections.push({ heading: line, body: [] });
    else sections.at(-1)!.body.push(line);
  }
  let used = false;
  // Each kind is filled once, in the first section that asks for it; a later one (Context after Motivation) keeps the template's words.
  const filledKinds = new Set<Kind>();
  const out = sections.map((s) => {
    const body = s.body.join("\n").trim();
    if (!s.heading) return body;
    const name = s.heading.replace(/^#+\s+/, "");
    const kind = kindOf(name, body);
    if (kind === "checklist") return `${s.heading}\n\n${tick(body, parts)}`.trimEnd();
    const text = filledKinds.has(kind) ? "" : textFor(kind, parts);
    // A section with boxes and a heading about tests: the box is ticked, the line says how.
    if (kind === "tests" && /^\s*[-*]\s*\[[ xX]\]/m.test(body)) return `${s.heading}\n\n${[tick(body, parts), text].filter(Boolean).join("\n\n")}`.trimEnd();
    if (!text) return `${s.heading}${body ? `\n\n${body}` : ""}`;
    used = true;
    filledKinds.add(kind);
    return `${s.heading}\n\n${text}`;
  });
  // A template with no headings (or none the session could answer) gets the why on top, so the description still says something.
  let filled = out.filter((x) => x !== "").join("\n\n");
  if (!used && parts.why) filled = `${parts.why}\n\n${filled}`.trim();
  const rest = full.trim();
  return rest ? `${filled}\n\n<details>\n<summary>The session behind this change</summary>\n\n${rest}\n\n</details>` : filled;
}
