import type { DiffFile } from "./types.js";

/**
 * What a run can show for itself.
 *
 * An agent's "done" is a sentence; this is the evidence under it, read from the
 * log and the diff rather than from what the agent said: the commands it really
 * ran, whether they passed, and the few things a run does that look like
 * success and aren't — weakening a test, or claiming one passed that never ran.
 */

/** Commands that are a test run, whatever the project calls them. */
export const TEST_CMD = /\b(test|tests|jest|vitest|pytest|mocha|rspec|phpunit|playwright|cypress|ava|tap)\b|go test|cargo test|gradle test|mvn test|dotnet test/i;

/** Joined so the exit status is the last command's, or deliberately ignored: `npm test; git diff`, `pytest || true`, `a & b`. */
const CHAINED = /;|\n|\|\||(?<![&|])&(?![&>])/;
/** What a test run prints when it did not pass, in the runners people use. */
const FAILED_OUTPUT = /npm (?:ERR!|error)\b|^\s*(?:Uncaught )?\w*Error(?: \[[\w-]+\])?:|\b[1-9]\d* (?:failed|failing)\b|^\s*FAIL(?:ED)?\b|\bexit(?:ed)? (?:with )?code [1-9]/im;

/**
 * A test command that failed although the command as a whole exited 0.
 *
 * An agent that runs `npm test; git diff` gets git's exit status, so a suite that crashed came back as a success, and the
 * review card said "Tests passed" beside the agent saying the tests could not run. Only for a test command whose status
 * was not its own, and only on what a failing run prints.
 */
export function testFailedInChain(command: string | undefined, output: string): boolean {
  return !!command && TEST_CMD.test(command) && CHAINED.test(command) && FAILED_OUTPUT.test(output);
}

/** The gate's answers (runtime.ts commandGate) when a command is put to a person rather than run. */
const ASKED = /^(That command needs a person's approval first|Still waiting for their answer|They said not to run that command|That command is \d+ characters)/;

/**
 * Whether a command failed, read from its result, or null when it never ran.
 *
 * Friday's own run_command marks a command that never ran as an error (waiting on a person's yes, told no, a machine
 * that didn't answer), because nothing ran and that is not a success. It is not a failure either: a run that stopped to
 * ask before `npm test` has neither passed nor failed its tests. Every command that ran answers with a transcript that
 * starts "$ ", or, from a machine on an older Friday that stopped it at its limit, "Timed out after". run_background and
 * show_preview go through the same question, and their answers while it is open are the gate's own words.
 */
export function commandFailed(r: { name: string; output: string; isError: boolean }): boolean | null {
  if (/^(run_command|run_background|show_preview)$/.test(r.name) && ASKED.test(r.output)) return null;
  return r.name === "run_command" && !/^(?:\$ |Timed out after)/.test(r.output) ? null : r.isError;
}

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$|Tests?\.(java|kt|cs)$/i;
/** Files whose change is not code, so "no tests ran" is no complaint. */
export const NOT_CODE = /\.(md|mdx|txt|rst|json|ya?ml|toml|lock|svg|png|jpe?g|gif|css|scss|html)$/i;
/** A test turned off rather than fixed. */
const SKIP = /\b(?:it|test|describe|context)\.(?:skip|todo)\s*\(|\bx(?:it|describe|test)\s*\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\w*\(|#\[ignore\]|@Disabled\b|@Ignore\b/;
/** A check made to stop complaining rather than satisfied: a type or lint error silenced in place. */
const SILENCE = /@ts-(?:ignore|nocheck|expect-error)\b|eslint-disable|#\s*type:\s*ignore|#\s*noqa\b|\/\/\s*nolint\b|#\s*pylint:\s*disable|@SuppressWarnings\b|#!?\[allow\(/;
/** An error caught and dropped on the floor: `except: pass`, an empty catch. */
const SWALLOW = /\bexcept(?:\s+[\w.]+(?:\s+as\s+\w+)?)?\s*:\s*pass\b|\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}|\brescue\s*(?:=>\s*\w+)?\s*;?\s*end\b|\bif\s+err\s*!=\s*nil\s*\{\s*\}/;
/** An assertion that pins a value, and one that only checks something exists or is truthy. */
const STRONG = /\.(?:toEqual|toStrictEqual|toBe|toMatchObject|toHaveBeenCalledWith|toThrow)\s*\(|\bassert(?:\.|_)?(?:equal|deepEqual|strictEqual|deepStrictEqual|Equal|Equals|_eq|_ne|ne|Raises)\b|\bassertEqual\w*\(|\bassert\s+\w[^=\n]*==|\bexpect\([^)]*\)\.to\.(?:equal|eql|deep)/;
const WEAK = /\.(?:toBeTruthy|toBeDefined|toBeFalsy|not\.toBeNull|not\.toThrow)\s*\(|\bassert\.ok\s*\(|\bassertTrue\s*\(|\bassertIsNotNone\s*\(|\bassert\s+\w+\s*$|\.to\.(?:be\.ok|exist)\b/;
/** A CI step told to pass whatever happens, or a test run told to pass with no tests. */
const CI_FILE = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|\.circleci\/|azure-pipelines\.ya?ml$|Jenkinsfile$|package\.json$)/;
const IGNORE_FAILURE = /continue-on-error:\s*true|allow_failure:\s*true|\|\|\s*true\b|--passWithNoTests|--pass-with-no-tests|exit\s+0\s*$/;

/** The diff's added and removed lines, without the file headers. */
const linesOf = (patch: string, sign: "+" | "-") => patch.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).map((l) => l.slice(1));

/** "all tests pass", "the suite is green", "build succeeds". */
const CLAIM = /\b(?:all\s+)?(?:the\s+)?(?:tests?|suite|specs?|build|checks?|ci)\b[^.\n]{0,40}\b(?:pass(?:es|ed|ing)?|green|succe(?:ed|eds|ssful)|work(?:s|ing))\b|\ball (?:tests )?(?:pass|green)\b/i;

export interface ReceiptCommand {
  command: string;
  ok: boolean;
  test: boolean;
}

export interface ReceiptFlag {
  level: "bad" | "warn";
  text: string;
}

export interface Receipt {
  commands: ReceiptCommand[];
  /** The newest attempt at each test command, worst first: one failure fails the run. */
  tests: "pass" | "fail" | "none";
  files: number;
  flags: ReceiptFlag[];
}

type Call = { id: string; name: string; arguments: string };

const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function receiptOf(input: {
  calls: Call[];
  /** True if that call errored, false if it worked, null if it has no result yet. */
  failed: (callId: string) => boolean | null;
  files: DiffFile[];
  /** What the agent finally said, for checking its claims against the commands. */
  answer?: string;
}): Receipt {
  // Every attempt is kept, so a failure that was then fixed reads as both.
  const commands: ReceiptCommand[] = [];
  for (const c of input.calls) {
    if (c.name !== "run_command" && c.name !== "shell") continue;
    let command = "";
    try {
      command = String((JSON.parse(c.arguments || "{}") as { command?: unknown }).command ?? "").trim();
    } catch {
      continue;
    }
    const f = input.failed(c.id);
    if (!command || f === null) continue;
    commands.push({ command, ok: !f, test: TEST_CMD.test(command) });
  }

  const lastByCommand = new Map<string, boolean>();
  for (const c of commands) if (c.test) lastByCommand.set(c.command, c.ok);
  const latest = [...lastByCommand.values()];
  const tests = !latest.length ? "none" : latest.includes(false) ? "fail" : "pass";

  const flags: ReceiptFlag[] = [];
  for (const f of input.files) {
    if (!TEST_FILE.test(f.path)) continue;
    if (f.status === "deleted") flags.push({ level: "bad", text: `Deleted the test file ${f.path}` });
    else if (f.patch.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++") && SKIP.test(l))) flags.push({ level: "bad", text: `Switched off a test in ${f.path}` });
    else if (f.deletions >= 3 && f.deletions > f.additions) flags.push({ level: "warn", text: `Removed ${f.deletions - f.additions} net lines from ${f.path}` });
  }
  // A skip added to a file that isn't named like a test is still a skipped test.
  for (const f of input.files) {
    if (TEST_FILE.test(f.path)) continue;
    if (f.patch.split("\n").some((l) => l.startsWith("+") && !l.startsWith("+++") && SKIP.test(l))) flags.push({ level: "bad", text: `Switched off a test in ${f.path}` });
  }
  // What looks like a fix and isn't: the ways an agent makes a red check go quiet, read from what it added.
  for (const f of input.files) {
    if (f.status === "deleted") continue;
    const added = linesOf(f.patch, "+");
    const removed = linesOf(f.patch, "-");
    if (added.some((l) => SILENCE.test(l))) flags.push({ level: "warn", text: `Silenced a type or lint check in ${f.path}` });
    if (added.some((l) => SWALLOW.test(l))) flags.push({ level: "warn", text: `Catches an error and ignores it in ${f.path}` });
    if (CI_FILE.test(f.path) && added.some((l) => IGNORE_FAILURE.test(l))) flags.push({ level: "bad", text: `Made a check pass whatever happens in ${f.path}` });
    if (TEST_FILE.test(f.path)) {
      const strongGone = removed.filter((l) => STRONG.test(l)).length - added.filter((l) => STRONG.test(l)).length;
      if (strongGone > 0 && added.some((l) => WEAK.test(l))) flags.push({ level: "bad", text: `Loosened ${strongGone === 1 ? "an assertion" : `${strongGone} assertions`} in ${f.path}` });
      else if (strongGone >= 2) flags.push({ level: "warn", text: `Removed ${strongGone} assertions from ${f.path}` });
    }
  }

  const claims = !!input.answer && CLAIM.test(input.answer);
  if (claims && tests === "none") flags.push({ level: "warn", text: "Says something passes, but ran no test command" });
  if (claims && tests === "fail") flags.push({ level: "bad", text: "Says tests pass, but the last test run failed" });
  if (!claims && tests === "none" && input.files.some((f) => !NOT_CODE.test(f.path) && !TEST_FILE.test(f.path))) flags.push({ level: "warn", text: "Changed code and ran no tests" });

  // Worst first, without repeating one fact twice.
  const seen = new Set<string>();
  const unique = flags.filter((f) => !seen.has(f.text) && !!seen.add(f.text)).sort((a, b) => Number(b.level === "bad") - Number(a.level === "bad"));
  return { commands: commands.map((c) => ({ ...c, command: short(c.command) })), tests, files: input.files.length, flags: unique };
}
