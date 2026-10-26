/**
 * `ask_human` questions are free text, but the agent is told to include "the
 * options if there are any" — so they usually arrive as inline runs like
 * "Which do you mean? A) foo B) bar C) baz". Pull those out so the approval
 * card can offer them as real choices instead of a wall of prose.
 */

export interface Choice {
  value: string;
  label: string;
  /** The marker the choice was written with ("A", "b", "2"), so an answer can name it the way the agent did. */
  key: string;
}

/** Marker keys, in the orders we accept a run to start from. */
const SEQUENCES = ["ABCDEFGH", "abcdefgh", "12345678"];

/**
 * Split a question into its lead-in prompt and any inline choices.
 * Returns no options unless at least two consecutive markers (A then B, or
 * 1 then 2) are found, so ordinary prose with a stray "a)" is left alone.
 */
export function parseChoices(text: string): { prompt: string; options: Choice[] } {
  const q = text.trim();
  const marks: { start: number; after: number; key: string }[] = [];
  // A marker is a single letter or number followed by ")" or ".", at a word
  // boundary, with whitespace after it.
  for (const m of q.matchAll(/(?:^|[\s(\[])([A-Za-z]|\d{1,2})[).]\s+/g)) {
    const lead = m[0].length - m[0].replace(/^[\s(\[]+/, "").length;
    marks.push({ start: m.index + lead, after: m.index + m[0].length, key: m[1]! });
  }

  for (const seq of SEQUENCES) {
    // Find the longest run of markers that follows this sequence in order.
    let best: typeof marks = [];
    for (let i = 0; i < marks.length; i++) {
      const run: typeof marks = [];
      let next = 0;
      for (let j = i; j < marks.length && next < seq.length; j++) {
        if (marks[j]!.key === seq[next]) {
          run.push(marks[j]!);
          next++;
        }
      }
      if (run.length > best.length) best = run;
    }
    if (best.length < 2) continue;

    // A "(a)" marker leaves its opening bracket at the end of the text before it.
    const prompt = q.slice(0, best[0]!.start).replace(/\($/, "").trim();
    const options: Choice[] = best.map((mark, i) => {
      // ponytail: the final option runs to the end of the string, so trailing
      // prose after the last choice lands inside it. Give ask_human a
      // structured options parameter if that becomes a real annoyance.
      const end = i + 1 < best.length ? best[i + 1]!.start : q.length;
      const label = q.slice(mark.after, end).replace(/\($/, "").trim().replace(/[,;]$/, "").trim();
      return { value: label, label, key: mark.key };
    });

    if (options.some((o) => !o.label)) continue;
    return { prompt: prompt || q, options };
  }

  return { prompt: q, options: [] };
}

/**
 * A coding tool's questions, at the end of its answer.
 *
 * Claude Code, Codex and the rest have no ask_human: when they need a decision
 * they end the turn and ask in prose, "[1] What's the goal? a. … b. …", and the
 * person has to type "1=b" back. Read off the end of the answer, those become
 * the same choices Friday's own questions get.
 *
 * This runs on every answer a coding tool gives, so it is meant to say nothing
 * far more often than not: only the last thing in the answer counts, a
 * question needs a question mark or a list of options under it, and an
 * answer that ends any other way (a summary, a plan, "let me know if…") asks
 * nothing.
 */
export interface AskOption {
  key: string;
  label: string;
  detail?: string;
}

export interface Ask {
  /** The number the agent gave the question, when it numbered them. */
  n?: number;
  question: string;
  options: AskOption[];
}

/** Bold, code ticks and links, gone: the card shows plain text. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** "**Label** — why", "Label — why", "Label: why" (only after bold), or just a label. */
function option(key: string, raw: string): AskOption {
  const bold = /^\*\*(.+?)\*\*\s*(?:[—–:-]+\s*|\.\s+)?(.*)$/.exec(raw.trim());
  const [label, detail] = bold ? [bold[1]!, bold[2]!] : (() => {
    const dash = /\s+(?:—|–|--)\s+/.exec(raw);
    return dash ? [raw.slice(0, dash.index), raw.slice(dash.index + dash[0].length)] : [raw, ""];
  })();
  const d = plain(detail);
  return { key, label: plain(label), ...(d ? { detail: d } : {}) };
}

// A list option: "- a. …", "a) …", "(a) …", "**A)** …", "2. …". Letters and numbers up to two digits.
const OPTION = /^(\s*)(?:[-*+•]\s+)?(?:\*\*|__)?(?:\(([A-Za-z]|\d{1,2})\)|([A-Za-z]|\d{1,2})[.)])(?:\*\*|__)?\s+(.*\S)\s*$/;
// A numbered question: "[1] …", "Q1: …", "1. …", "**1.** …", "### 2) …".
const NUMBERED = /^(\s*)(?:#{1,6}\s+)?(?:[-*+]\s+)?(?:\*\*|__)?(?:\[(\d{1,2})\]|[Qq](\d{1,2})\s*[:.)]?|(\d{1,2})[.)](?=\s|\*\*|__))(?:\*\*|__)?\s*[:.]?\s*(.*\S)\s*$/;

interface Group {
  n?: number;
  /** How it was numbered, so "1." options under a "[1]" question are told apart from the next question. */
  style?: "bracket" | "q" | "dot";
  indent: number;
  question: string;
  options: (AskOption & { indent: number })[];
}

/** The key that would come after this one: b after a, B after A, 3 after 2. */
const nextKey = (k: string) => (/^\d+$/.test(k) ? String(Number(k) + 1) : String.fromCharCode(k.charCodeAt(0) + 1));
const firstKey = (k: string) => k === "1" || k === "a" || k === "A";

/**
 * Lines after the questions that are still part of asking: "(Answering "1=a" is enough.)", "_Pick one._", "Let me know
 * which you prefer." They don't end the questions; anything else after them does.
 */
const FOOTER = /^\s*(?:\(.*\)|_.*_|\*[^*].*\*|(?:let me know|reply|answer|pick|choose|tell me|just say)\b.*)\s*$/i;

export function parseAsks(text: string): Ask[] {
  // Only what comes after the last code block can be the end of the answer, and an answer that ends in code asks nothing.
  const fences = text.split(/^\s*(?:```|~~~)/m);
  if (fences.length % 2 === 0) return [];
  const tail = fences.at(-1)!;

  let groups: Group[] = [];
  /** The line just before, when it was prose: "Pick one:" over a list of options is the question that list answers. */
  let lead: { text: string; indent: number } | null = null;
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const cur = groups.at(-1);
    const o = OPTION.exec(line);
    if (o) {
      const key = o[2] ?? o[3]!;
      const prev = cur?.options.at(-1);
      // The next option of the question above: the key that comes next, and a number only where it can't be the next
      // question (under a "[1]" or unnumbered question, or indented under a "1.", and not itself asking something).
      const numeric = !/\D/.test(key);
      const fits = cur && (prev ? key === nextKey(prev.key) : firstKey(key)) && (!numeric || ((cur.style !== "dot" || indent > cur.indent) && !/\?\W*$/.test(plain(o[4]!))));
      if (fits) {
        cur.options.push({ ...option(key, o[4]!), indent });
        lead = null;
        continue;
      }
      // Lettered only: "Here's what I did:" over "1. … 2. …" is a summary, but "a) … b) …" under anything is a choice.
      if (lead && firstKey(key) && !numeric) {
        groups.push({ indent: lead.indent, question: lead.text, options: [{ ...option(key, o[4]!), indent }] });
        lead = null;
        continue;
      }
    }
    const q = NUMBERED.exec(line);
    if (q) {
      const n = Number(q[2] ?? q[3] ?? q[4]);
      groups.push({ n, style: q[2] ? "bracket" : q[3] ? "q" : "dot", indent, question: q[5]!, options: [] });
      lead = null;
      continue;
    }
    // A line under the last option, indented past it, says more about that option.
    const last = cur?.options.at(-1);
    if (last && indent > last.indent && !/^\s*[>|]/.test(line)) {
      last.detail = plain(`${last.detail ?? ""} ${line}`);
      continue;
    }
    if (groups.length && FOOTER.test(line) && !/\?\W*$/.test(line)) continue;
    const said = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+)/, "");
    if (/^\s*[>|]/.test(line)) {
      groups = [];
      lead = null;
    } else if (/\?\W*$/.test(plain(said)) || /\?\W*$/.test(plain(parseChoices(said).prompt))) {
      // A question, or one with its options after it on the same line: "Which next? A) the docs B) the tests".
      groups.push({ indent, question: said, options: [] });
      lead = null;
    } else {
      // Prose: whatever was asked before it was not the end of the answer.
      groups = [];
      lead = { text: said, indent };
    }
  }
  if (!groups.length) return [];

  // The questions at the very end, all numbered or all not: an unnumbered line over numbered questions is their lead-in.
  const numbered = groups.at(-1)!.n !== undefined;
  let start = groups.length;
  while (start > 0 && (groups[start - 1]!.n !== undefined) === numbered) start--;
  const block = groups.slice(start);

  const asks: Ask[] = [];
  for (const [i, g] of block.entries()) {
    const question = plain(g.question);
    let options: AskOption[] = g.options.map(({ indent: _, ...o }) => o);
    let prompt = question;
    // Options written on the question's own line: "Which one? A) … B) …".
    if (!options.length) {
      const inline = parseChoices(g.question);
      if (inline.options.length) {
        prompt = plain(inline.prompt);
        options = inline.options.map((c) => option(c.key, c.value));
      }
    }
    // One option is not a choice, and a line with neither options nor a question mark is not a question.
    if (options.length === 1 || !prompt || (!options.length && !/\?\W*$/.test(prompt))) return [];
    if (numbered && g.n !== i + 1) return [];
    // An unnumbered question with nothing to choose between is conversation, answered in the box under the chat.
    if (!options.length && !numbered) continue;
    asks.push({ ...(numbered ? { n: g.n } : {}), question: prompt, options });
  }
  // Only a choice is a decision (Arun, 2026-10-24: "only multiple choice answers should prompt this"): questions with nothing
  // to pick ("Want me to go deeper on any of these?", "Should I go on?") got a card with no choices on it. A tool's numbered
  // questions where one has options keep the free-text ones beside it, since they're answered together.
  return asks.some((a) => a.options.length) ? asks : [];
}

/** What the person picked for one question: one of its options, or words of their own. */
export type AskAnswer = { key: string; label: string } | { text: string };

/**
 * The answers, as the next instruction: "1=b (Cross-network generalisation)", one line a question, in the agent's own
 * shorthand so it reads them the way it asked, with the words so the room can too.
 */
export function askReply(asks: Ask[], answers: (AskAnswer | undefined)[]): string {
  return asks
    .flatMap((a, i) => {
      const ans = answers[i];
      if (!ans) return [];
      const said = "text" in ans ? ans.text.trim() : `${ans.key} (${ans.label})`;
      if (!said) return [];
      if (a.n !== undefined) return [`${a.n}${"text" in ans ? ": " : "="}${said}`];
      return [asks.length > 1 ? `${a.question} ${said}` : said];
    })
    .join("\n");
}
