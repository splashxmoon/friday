/**
 * Finished attempts at the same task, compared on what can be counted.
 *
 * A race is only useful if it ends in more than "here are the diffs". This says, metric by metric, which attempt did better,
 * and whether there is a reason to lean one way. It does not pretend to judge quality: it reads tests, whether anything looked
 * like cheating, how much changed and how long it took, and says so. When the evidence is a tie, so is the verdict. Two
 * attempts or five (Arun, 2026-10-25: one prompt to several agents, compare, keep the winner).
 */

export interface Racer {
  id: string;
  name: string;
  tests: "pass" | "fail" | "none";
  /** Receipt flags that mean something is wrong: a test switched off, a failing command ignored. */
  red: number;
  files: number;
  added: number;
  removed: number;
  /** Seconds the runs took. */
  seconds: number;
  /** Tokens, when the agent reports them; null for a coding tool on somebody's own plan. */
  tokens: number | null;
  commands: number;
  finished: boolean;
}

export type Side = "a" | "b" | "tie" | "unknown";

/** One metric across every attempt: a value for each, and which did best on it (none when they're level, or it can't be told). */
export interface ManyRow {
  key: "tests" | "size" | "time" | "tokens";
  label: string;
  values: string[];
  /** Indexes of the attempts that did best; empty for a tie. */
  best: number[];
  /** The metric couldn't be compared: not all finished, or not all report it. */
  unknown?: true;
}

export interface ManyVerdict {
  rows: ManyRow[];
  /** The attempt the evidence leans toward, by id, or null when it does not lean. */
  lean: string | null;
  /** In words: the reasons, or why there are none. */
  why: string;
}

/** The two-attempt view of a row, as the first race card read it. */
export interface Row {
  key: ManyRow["key"];
  label: string;
  a: string;
  b: string;
  better: Side;
}

export interface Verdict {
  rows: Row[];
  lean: string | null;
  why: string;
}

const TESTS_RANK = { pass: 2, none: 1, fail: 0 } as const;
const TESTS_WORD = { pass: "passed", none: "not run", fail: "failed" } as const;
const lines = (r: Racer) => r.added + r.removed;

function secs(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}
const tok = (n: number | null) => (n === null ? "not counted" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * Who is lowest on a number, within a slack: the lowest and anyone close to it. Everyone close to the lowest is a tie (no one
 * is best); otherwise those within the slack of the lowest are best.
 */
function lowest(values: number[], slack: number): number[] {
  const min = Math.min(...values);
  const best = values.flatMap((v, i) => (v - min <= slack ? [i] : []));
  return best.length === values.length ? [] : best;
}

export function scoreMany(rs: Racer[]): ManyVerdict {
  const rows: ManyRow[] = [];
  const all = rs.every((r) => r.finished);
  // Tests: the highest rank wins, unless everyone is at the same rank.
  const ranks = rs.map((r) => TESTS_RANK[r.tests]);
  const topRank = Math.max(...ranks);
  const testsBest = ranks.every((x) => x === topRank) ? [] : ranks.flatMap((x, i) => (x === topRank ? [i] : []));
  rows.push({ key: "tests", label: "Tests", values: rs.map((r) => TESTS_WORD[r.tests]), best: testsBest });
  // A difference of a few lines is noise; the smaller change is better only when it is meaningfully smaller.
  const sizes = rs.map(lines);
  const sizeBest = lowest(sizes, Math.max(5, Math.round(Math.max(...sizes) * 0.15)));
  rows.push({ key: "size", label: "Size of the change", values: rs.map((r) => `${plural(r.files, "file")}, +${r.added} −${r.removed}`), best: sizeBest });
  const times = rs.map((r) => r.seconds);
  const timeBest = all ? lowest(times, Math.max(10, Math.round(Math.max(...times) * 0.2))) : [];
  rows.push({ key: "time", label: "Time", values: rs.map((r) => secs(r.seconds)), best: timeBest, ...(all ? {} : { unknown: true as const }) });
  const tokensKnown = rs.every((r) => r.tokens !== null);
  const tokBest = tokensKnown ? lowest(rs.map((r) => r.tokens!), Math.max(500, Math.round(Math.max(...rs.map((r) => r.tokens!)) * 0.2))) : [];
  rows.push({ key: "tokens", label: "Tokens", values: rs.map((r) => tok(r.tokens)), best: tokBest, ...(tokensKnown ? {} : { unknown: true as const }) });

  if (!all) return { rows, lean: null, why: rs.length === 2 ? "Not both finished yet." : "Not all finished yet." };

  const reasons: string[] = [];
  let lean: Racer | null = null;
  // Cheating comes first: a green run that switched a test off has not passed anything.
  const reds = rs.map((r) => r.red);
  const fewestRed = Math.min(...reds);
  const cleanest = rs.flatMap((r, i) => (reds[i] === fewestRed ? [r] : []));
  if (cleanest.length === 1 && !reds.every((x) => x === fewestRed)) {
    const w = cleanest[0]!;
    const losers = rs.filter((r) => r !== w);
    lean = w;
    reasons.push(`${list(losers.map((l) => `${l.name} has ${plural(l.red, "red flag")}`))} (${w.name} has ${w.red ? w.red : "none"})`);
  }
  if (!lean && testsBest.length === 1) {
    const w = rs[testsBest[0]!]!;
    const losers = rs.filter((r) => r !== w);
    lean = w;
    reasons.push(`its tests ${TESTS_WORD[w.tests]}, ${list(losers.map((l) => `${l.name}'s ${TESTS_WORD[l.tests]}`))}`);
  }
  if (!lean && sizeBest.length === 1 && ranks.every((x) => x === ranks[0])) {
    const w = rs[sizeBest[0]!]!;
    const losers = rs.filter((r) => r !== w);
    lean = w;
    reasons.push(`the change is smaller (${lines(w)} lines against ${list(losers.map((l) => String(lines(l))))})`);
  }
  if (!lean) {
    const fastest = timeBest.length === 1 ? rs[timeBest[0]!] : null;
    // Some fell behind on tests, but more than one is out in front: the front runners are named, and so are the others.
    if (testsBest.length > 1) {
      const front = testsBest.map((i) => rs[i]!.name);
      const behind = rs.filter((_, i) => !testsBest.includes(i));
      return { rows, lean: null, why: `${list(front)} are level on tests and size; ${list(behind.map((l) => `${l.name}'s tests ${TESTS_WORD[l.tests]}`))}. Read ${front.length === 2 ? "both" : "their"} changes and choose.` };
    }
    return { rows, lean: null, why: fastest ? `Tests and size are a tie; ${fastest.name} was faster.` : "Nothing separates them on tests, size or time. Read the changes and choose." };
  }
  const w = lean as Racer;
  return { rows, lean: w.id, why: `${w.name}: ${reasons.join(", and ")}. That is what can be counted; it says nothing about which one is better written.` };
}

/** Two attempts, in the shape the first race card read. */
export function scoreRace(a: Racer, b: Racer): Verdict {
  const m = scoreMany([a, b]);
  const side = (r: ManyRow): Side => (r.unknown ? "unknown" : r.best.length === 1 ? (r.best[0] === 0 ? "a" : "b") : "tie");
  return { rows: m.rows.map((r) => ({ key: r.key, label: r.label, a: r.values[0]!, b: r.values[1]!, better: side(r) })), lean: m.lean, why: m.why };
}
