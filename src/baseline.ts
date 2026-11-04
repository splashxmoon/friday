import type { SessionEvent } from "./types.js";

/**
 * Already failing at the start (Arun, 2026-11-03, of the shortlist: "Was it already broken?"; docs/plans/dev-essentials.md §1).
 *
 * Agents spend turns chasing test failures that were there before they began, and a person reading "3 tests failed" can't tell
 * which are the agent's. So the first time a test command fails in a repo, Friday runs the same command on the commit the agent's
 * copy started from, once, in a throwaway copy of its own (the runner's `baseline` op), and keeps what failed there. Every agent
 * and teammate working from that commit shares it, and only a failure that wasn't there before counts against a change.
 *
 * These are the pure parts: reading which tests failed from what a runner printed, telling a run that couldn't be set up from
 * one that failed, and splitting a run's failures into those that were already there and those that are new. No I/O here.
 */

/** What the base commit came to for one command. */
export interface Baseline {
  /** The command as it was run there (normalised: see commandKey). */
  command: string;
  /** The commit it was run at. */
  base: string;
  /** It exited 0 there. */
  ok: boolean;
  /** The tests that failed there, when the runner's output names them; null when it doesn't. */
  failing: string[] | null;
  /** It couldn't be run there for reasons that aren't the code's (a missing module, no such command, no copy): claims nothing. */
  setup?: true;
  at: number;
}

/** How a run's failures stand against the base. */
export interface Compared {
  /** Failing in the run and at the base too: not the change's. */
  pre: string[];
  /** Failing in the run and not at the base: the change's. */
  fresh: string[];
  /** Names couldn't be read on one side or the other: the whole command failed at the base too (true) or passed there (false). */
  whole?: boolean;
}

/** Colour codes, which some runners print even with NO_COLOR set. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** A duration after a test's name: "(12.3ms)", "(5 ms)", "[1.2s]", "(0.00s)". */
const TIME = /\s*[([]\s*\d+(?:\.\d+)?\s*(?:ms|s|m)\s*[)\]]\s*$/;

/**
 * The tests a run's output says failed, in the runners people use, each once, in order; null when none can be read (an unknown
 * runner, or output cut short before its failures). Read from the whole transcript the runner's shell op gives back.
 */
export function failingTests(output: string): string[] | null {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    const name = (s ?? "").replace(TIME, "").replace(/\s+/g, " ").trim();
    if (name && name.length <= 300 && !/^(?:failing tests|tests? failed|failed|failures?)\b:?$/i.test(name)) out.add(name);
  };
  for (const raw of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    // node --test (spec): "✖ name (1.2ms)"; its "✖ failing tests:" header is left out by add.
    if ((m = line.match(/^\s*✖\s+(.+)$/))) add(m[1]);
    // TAP (node --test, tape, prove): "not ok 3 - name".
    else if ((m = line.match(/^\s*not ok \d+\s*-?\s*(.+?)(?:\s+#.*)?$/))) add(m[1]);
    // Jest and Vitest: "✕ name (5 ms)", "× name", and Vitest's "FAIL  file > suite > name".
    else if ((m = line.match(/^\s*[✕×]\s+(.+)$/))) add(m[1]);
    else if ((m = line.match(/^\s*FAIL\s+(\S.*\s>\s.+)$/))) add(m[1]);
    // Jest's failure headers: "● Suite › name".
    else if ((m = line.match(/^\s*●\s+(.+›.+)$/))) add(m[1]);
    // pytest: "FAILED tests/test_a.py::test_x - AssertionError: …".
    else if ((m = line.match(/^FAILED\s+(\S+)/))) add(m[1]);
    // Go: "--- FAIL: TestName (0.00s)".
    else if ((m = line.match(/^\s*--- FAIL:\s+(\S+)/))) add(m[1]);
    // cargo test: "test path::name ... FAILED".
    else if ((m = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED$/))) add(m[1]);
    // RSpec: "rspec ./spec/a_spec.rb:12 # description".
    else if ((m = line.match(/^rspec\s+\S+\s+#\s+(.+)$/))) add(m[1]);
    // PHPUnit: "1) Tests\FooTest::testBar".
    else if ((m = line.match(/^\d+\)\s+([\w\\]+::\w+)/))) add(m[1]);
  }
  return out.size ? [...out] : null;
}

/** The shell op's transcript ("$ cmd", then "(exited N)" or "(timed out …)", then the output): its exit code, or null. */
export function exitOf(transcript: string): number | null {
  const m = transcript.match(/^\$ [^\n]*\n\(exited (-?\d+)\)/);
  return m ? Number(m[1]) : null;
}

/** What only a copy that couldn't be set up prints: the code under test never ran. */
const SETUP = /Cannot find module|ERR_MODULE_NOT_FOUND|command not found|is not recognized as (?:an internal|the name of)|ModuleNotFoundError|No module named|Missing script|missing script:|ENOENT[^\n]*(?:package\.json|node_modules)|Couldn't make a copy/i;

/** The base run's transcript as a baseline. A timeout, a refusal or a setup failure claims nothing. */
export function baselineOf(command: string, base: string, transcript: string, at = Date.now()): Baseline {
  const code = exitOf(transcript);
  if (code === null) return { command, base, ok: false, failing: null, setup: true, at };
  if (code !== 0 && SETUP.test(transcript) && !failingTests(transcript)) return { command, base, ok: false, failing: null, setup: true, at };
  return { command, base, ok: code === 0, failing: code === 0 ? [] : failingTests(transcript), at };
}

/**
 * A command as it is kept and re-run: what it says, without what only trims its output. An agent's `npm test 2>&1 | tail -40`
 * is the suite; at the base it is run whole, so the failures past the tail are counted too.
 */
export function commandKey(command: string): string {
  let c = command.replace(/\s+/g, " ").trim();
  // Trailing filters on the output, one after another.
  for (let i = 0; i < 4; i++) c = c.replace(/\s*\|\s*(?:tail|head|grep|egrep|less|more|cat|tee|sed|awk|cut)\b[^|]*$/, "").trim();
  return c.replace(/\s*2>&1\s*$/, "").replace(/\s*;?\s*(?:echo\s+["']?(?:EXIT|exit)[^;]*)$/, "").trim();
}

/** A run's failures against the base. Null when the base can't say: it couldn't be set up, or the run's failures can't be read and the base passed. */
export function compare(failing: string[] | null, base: Baseline): Compared | null {
  if (base.setup) return null;
  if (failing && base.failing) {
    const was = new Set(base.failing);
    return { pre: failing.filter((n) => was.has(n)), fresh: failing.filter((n) => !was.has(n)) };
  }
  // Names on one side only: the whole command, as far as it can be said.
  if (!base.ok) return { pre: [], fresh: [], whole: true };
  return failing ? { pre: [], fresh: failing } : { pre: [], fresh: [], whole: false };
}

/** Nothing the run failed is its own: every failure was already there, or the command fails at the base as a whole. */
export const onlyPre = (c: Compared | null): boolean => !!c && !c.fresh.length && (c.pre.length > 0 || c.whole === true);

/** "2 already failing on main" and the like, for a card; "" when there is nothing to say. */
export function preWords(c: Compared | null, branch = "main"): string {
  if (!c) return "";
  if (c.pre.length) return `${c.pre.length} already failing on ${branch}`;
  if (c.whole) return `fails on ${branch} too`;
  return "";
}

/**
 * What an agent is told about failures that were already there, so it doesn't chase them unless asked. "" when there are none.
 */
export function preNote(c: Compared | null, command: string, base: string): string {
  if (!c || (!c.pre.length && !c.whole)) return "";
  const at = base.slice(0, 7);
  if (c.pre.length) {
    const list = c.pre.slice(0, 12).map((n) => `- ${n}`).join("\n");
    return `[Friday] These tests already failed at ${at}, the commit your copy started from, before any change of yours, so they aren't yours to fix unless you're asked to (\`${command}\`):\n${list}${c.pre.length > 12 ? `\n…and ${c.pre.length - 12} more` : ""}`;
  }
  return `[Friday] \`${command}\` already fails at ${at}, the commit your copy started from, before any change of yours: don't spend your turn on its failures unless you're asked to, and say which are new if you can tell.`;
}

/**
 * What an agent is told at the start of its next turn after a run that ended with tests failing that were already failing at its
 * base (tests.base): said once, on the turn right after, never again. "" when there's nothing to tell.
 */
export function baseNote(events: readonly SessionEvent[], lane: string): string {
  const on = (e: SessionEvent) => (e.lane ?? "main") === lane;
  const said = events.findLast((e) => on(e) && e.body.type === "tests.base");
  if (!said || said.body.type !== "tests.base") return "";
  const starts = events.filter((e) => on(e) && e.body.type === "run.started");
  const now = starts.at(-1)?.seq ?? Infinity;
  const before = starts.at(-2)?.seq ?? 0;
  if (said.seq < before || said.seq > now) return "";
  const b = said.body;
  return preNote({ pre: b.pre, fresh: b.fresh, ...(b.whole !== undefined ? { whole: b.whole } : {}) }, b.command, b.base);
}
