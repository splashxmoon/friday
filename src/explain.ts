import type { ReceiptFlag } from "./receipt.js";
import type { DiffFile } from "./types.js";

/**
 * The diff explained before it is shown: what changed, why, and what to look at first.
 *
 * Three sentences over every review card, read from the log rather than asked of a model: the files and their sizes,
 * the instruction that set the run going and what the agent wrote down on the way, and the one place a reviewer's eye
 * should go first, which is a flag if there is one and the biggest change if there is not.
 */

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "src/session" for most of the files, or "" when they are spread about. */
function mostlyUnder(files: DiffFile[]): string {
  const count = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split("/");
    if (parts.length < 2) continue;
    const dir = parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    count.set(dir, (count.get(dir) ?? 0) + 1);
  }
  const top = [...count].sort((a, b) => b[1] - a[1])[0];
  return top && files.length > 1 && top[1] >= Math.ceil(files.length / 2) ? top[0] : "";
}

export function explainRun(input: {
  files: DiffFile[];
  /** Who asked for this run and what they said, when the log knows. */
  ask?: { who: string; text: string };
  /** Paths in the set that were already waiting from an earlier run, untouched by this one. */
  earlier?: string[];
  /** What the agent wrote down as decided during the run, in order. */
  decided?: string[];
  flags?: ReceiptFlag[];
  tests?: "pass" | "fail" | "none";
}): string[] {
  const { files } = input;
  if (!files.length) return [];
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);
  const fresh = files.filter((f) => f.status === "added").length;
  const gone = files.filter((f) => f.status === "deleted").length;
  const out: string[] = [];

  // What changed, in sizes a reviewer can weigh.
  const where = mostlyUnder(files);
  const extras = [fresh ? `${fresh} new` : "", gone ? `${gone} deleted` : ""].filter(Boolean).join(", ");
  out.push(
    files.length === 1
      ? `Changed ${files[0]!.path} (+${adds} −${dels}).`
      : `Changed ${files.length} files (+${adds} −${dels})${where ? `, mostly under ${where}` : ""}${extras ? `; ${extras}` : ""}.`,
  );
  // A coding tool reports everything uncommitted: say which of it this run didn't touch, so "because" isn't read as covering it.
  const earlier = input.earlier?.length && input.earlier.length < files.length ? input.earlier : [];
  if (earlier.length) out.push(earlier.length === 1 ? `${earlier[0]} was already waiting from earlier.` : `${earlier.length} of them were already waiting from earlier.`);

  // Why: the words that set it going, and the last thing the agent wrote down on the way.
  const why: string[] = [];
  if (input.ask?.text) why.push(`Because ${input.ask.who} asked: “${clip(input.ask.text, 140).replace(/[.!?]+$/, "")}”.`);
  const last = input.decided?.at(-1);
  if (last) why.push(`On the way it decided: ${clip(last.replace(/\.$/, ""), 120)}.`);
  if (why.length) out.push(why.join(" "));

  // Where to look first: a flag beats everything; otherwise the biggest change, with the test news beside it.
  const bad = input.flags?.find((f) => f.level === "bad") ?? input.flags?.[0];
  if (bad) out.push(`Look here first: ${bad.text.replace(/\.$/, "")}.`);
  else {
    const biggest = [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))[0]!;
    const tests = input.tests === "pass" ? "; the tests passed" : input.tests === "fail" ? "; the tests failed" : input.tests === "none" ? "; no tests ran" : "";
    out.push(files.length === 1 ? `Nothing else moved${tests}.` : `Start with ${biggest.path}, the biggest change (+${biggest.additions} −${biggest.deletions})${tests}.`);
  }
  return out;
}

/** "Done · tests passed", "Done · unverified": one word on the agent's "done", so it never means two things. */
export function doneVerdict(changed: number, tests: "pass" | "fail" | null): { text: string; tone: "pass" | "fail" | "none" } | null {
  if (!changed) return null;
  if (tests === "pass") return { text: "Done · tests passed", tone: "pass" };
  if (tests === "fail") return { text: "Done · tests failed", tone: "fail" };
  return { text: "Done · unverified", tone: "none" };
}
