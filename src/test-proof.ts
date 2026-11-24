/**
 * Proof for a change that draws nothing: its tests (Arun, 2026-11-22: "how do we show proofs for tests ran and stuff?", "Yes, build it").
 * A clip shows a page; a library, an API or a script is shown by the tests that ran on it. Read from the run itself (no model call): each
 * test command its agent ran, its last attempt (one that failed and was then fixed is a pass), whether it passed, the counts its runner
 * printed, the tests that failed by name (baseline.ts failingTests), how long it took, and the end of its output. Kept as a proof.tests
 * event as the run ends, so the chat, the phone and Code Review show the same thing; Friday's own run of a check a reply only claimed
 * comes the same way (by: "friday").
 */
import { failingTests } from "./baseline.js";
import { commandFailed, keyOf, TEST_CMD } from "./receipt.js";
import type { SessionEvent } from "./types.js";

export interface TestRun {
  command: string;
  ok: boolean;
  passed?: number;
  failed?: number;
  skipped?: number;
  /** The tests that failed, by name, at most eight. */
  failing?: string[];
  /** How long it took, from the call to its answer. */
  ms?: number;
  /** The end of its output, for "Show output". */
  tail: string;
}

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const n = (s: string | undefined) => (s === undefined ? undefined : Number(s));

/** The counts a runner prints at the end, in the runners people use; what it didn't print is left out. */
export function testCounts(output: string): { passed?: number; failed?: number; skipped?: number } {
  const t = output.replace(ANSI, "");
  let m: RegExpMatchArray | null;
  // Jest: "Tests:       2 failed, 1 skipped, 140 passed, 143 total".
  if ((m = t.match(/^Tests:\s+(.+total)$/m))) {
    const part = (w: string) => n(m![1]!.match(new RegExp(`(\\d+) ${w}`))?.[1]);
    return clean({ passed: part("passed"), failed: part("failed"), skipped: part("skipped") });
  }
  // Vitest: "Tests  2 failed | 140 passed (142)".
  if ((m = t.match(/^\s*Tests\s+(.+\(\d+\))\s*$/m))) {
    const part = (w: string) => n(m![1]!.match(new RegExp(`(\\d+) ${w}`))?.[1]);
    return clean({ passed: part("passed"), failed: part("failed"), skipped: part("skipped") });
  }
  // node --test / TAP: "# pass 140", "# fail 2", "# skipped 1" (ℹ in the spec reporter).
  const tap = (w: string) => n(t.match(new RegExp(`^(?:#|ℹ)\\s*${w}\\s+(\\d+)\\s*$`, "m"))?.[1]);
  if (tap("pass") !== undefined || tap("fail") !== undefined) return clean({ passed: tap("pass"), failed: tap("fail"), skipped: tap("skipped") ?? tap("skip") });
  // pytest: "==== 2 failed, 140 passed, 1 skipped in 3.21s ====".
  if ((m = t.match(/=+ (.*(?:passed|failed).*) in [\d.]+s/))) {
    const part = (w: string) => n(m![1]!.match(new RegExp(`(\\d+) ${w}`))?.[1]);
    return clean({ passed: part("passed"), failed: part("failed"), skipped: part("skipped") });
  }
  // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored", one line per test binary in a workspace: added up.
  const cargo = [...t.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed(?:; (\d+) ignored)?/g)];
  if (cargo.length) {
    const sum = (i: number) => cargo.reduce((a, x) => a + Number(x[i] ?? 0), 0);
    return clean({ passed: sum(1), failed: sum(2), skipped: sum(3) });
  }
  // RSpec: "143 examples, 2 failures, 1 pending".
  if ((m = t.match(/(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/))) return clean({ passed: Number(m[1]) - Number(m[2]) - Number(m[3] ?? 0), failed: n(m[2]), skipped: n(m[3]) });
  return {};
}
const clean = (o: { passed?: number; failed?: number; skipped?: number }) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && Number.isFinite(v))) as { passed?: number; failed?: number; skipped?: number };

/** The last lines of an output, as many as fit in `max` characters. */
export function tailOf(output: string, lines = 30, max = 2500): string {
  const t = output.replace(ANSI, "").replace(/\s+$/, "");
  const cut = t.split(/\r?\n/).slice(-lines).join("\n");
  return cut.length > max ? cut.slice(cut.length - max) : cut;
}

/** A shell call's command, whatever the tool named it. */
function commandOf(name: string, raw: string): string {
  if (!/^(run_command|shell|bash|exec_command|local_shell)$/i.test(name)) return "";
  try {
    const a = JSON.parse(raw || "{}") as { command?: unknown; cmd?: unknown };
    const c = a.command ?? a.cmd;
    return (Array.isArray(c) ? c.join(" ") : String(c ?? "")).trim();
  } catch {
    return "";
  }
}

/** A command as one: what only trims its output ("| tail -40", "2>&1") doesn't make it another (also the chat's failed-commands line). */
export { keyOf };

/** How long the runner said it took ("ℹ duration_ms 212", pytest's "in 3.21s", Jest's "Time: 3.2 s", cargo's "finished in 0.42s"). */
export function durationIn(output: string): number | undefined {
  const t = output.replace(ANSI, "");
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:#|ℹ)\s*duration_ms\s+([\d.]+)\s*$/m))) return Math.round(Number(m[1]));
  if ((m = t.match(/^Time:\s+([\d.]+)\s*(ms|s)\b/m))) return Math.round(Number(m[1]) * (m[2] === "s" ? 1000 : 1));
  if ((m = t.match(/=+ .*(?:passed|failed).* in ([\d.]+)s/) ?? t.match(/finished in ([\d.]+)s/))) return Math.round(Number(m[1]) * 1000);
  if ((m = t.match(/^\s*Duration\s+([\d.]+)(ms|s)\b/m))) return Math.round(Number(m[1]) * (m[2] === "s" ? 1000 : 1));
  return undefined;
}

/** The shell never found the command (or the folder) it was asked to run. */
export const neverRan = (output: string) => /command not found|: not found$|is not recognized as an internal or external command|cannot find the path specified|No such file or directory/im.test(output.replace(ANSI, ""));

/** The test part of a command that does more ("cd app && npm test", "git status --short && cargo test -q"): what the card shows. */
export function testPart(command: string): string {
  const parts = command.split(/\s*(?:&&|\|\||;)\s*/).map((p) => p.trim()).filter(Boolean);
  return parts.findLast((p) => TEST_CMD.test(p)) ?? command;
}

/** The test commands one run of a lane ran, each once (its last attempt), in the order they last ran. */
export function testRunsIn(events: readonly SessionEvent[], lane: string, start: number, end: number): TestRun[] {
  const onLane = (e: SessionEvent) => (e.lane ?? "main") === lane && e.seq > start && e.seq <= end;
  const results = new Map<string, { body: { name: string; output: string; isError: boolean }; ts: number }>();
  for (const e of events) if (onLane(e) && e.body.type === "tool.result") results.set(e.body.callId, { body: e.body as never, ts: e.ts });
  const last = new Map<string, TestRun>();
  for (const e of events) {
    if (!onLane(e) || e.body.type !== "agent.message") continue;
    for (const c of e.body.toolCalls ?? []) {
      const command = commandOf(c.name, c.arguments);
      if (!command || !TEST_CMD.test(command)) continue;
      const r = results.get(c.id);
      const said = r ? commandFailed({ ...r.body, name: r.body.name ?? c.name }) : null;
      if (!r || said === null) continue;
      const counts = testCounts(r.body.output);
      // A run that never got to the tests (Arun's video harness, 2026-11-22: `timeout 600 cargo test` on a Mac with no timeout,
      // which its tool still called a success) proves nothing either way: left out, never shown as passing.
      if (neverRan(r.body.output) && !Object.keys(counts).length) continue;
      // The exit code the shell printed, when the tool's own flag says otherwise.
      const failed = said || /\(exited ([1-9]\d*)\)/.test(r.body.output) || !!counts.failed;
      const names = failed ? (failingTests(r.body.output) ?? []).slice(0, 8) : [];
      const key = keyOf(command);
      last.delete(key);
      last.set(key, { command: testPart(key), ok: !failed, ...counts, ...(names.length ? { failing: names } : {}), ...msOf(r.body.output, r.ts - e.ts), tail: tailOf(r.body.output) });
    }
  }
  return [...last.values()].slice(-4);
}

/** The runner's own time, else the time from the call to its answer when that is a real one (a call answered at once says nothing). */
const msOf = (output: string, between: number): { ms?: number } => {
  const said = durationIn(output);
  return said !== undefined ? { ms: said } : between >= 100 ? { ms: between } : {};
};

/** "140 passed · 2 failed · 12.4s", for a line under the command. */
export function countsLine(r: Pick<TestRun, "passed" | "failed" | "skipped" | "ms">): string {
  const secs = r.ms === undefined ? "" : r.ms < 1000 ? `${r.ms}ms` : r.ms < 60_000 ? `${(r.ms / 1000).toFixed(1)}s` : `${Math.floor(r.ms / 60_000)}m ${Math.round((r.ms % 60_000) / 1000)}s`;
  return [r.passed !== undefined ? `${r.passed} passed` : "", r.failed ? `${r.failed} failed` : "", r.skipped ? `${r.skipped} skipped` : "", secs].filter(Boolean).join(" · ");
}
