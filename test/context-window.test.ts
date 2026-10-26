import assert from "node:assert/strict";
import { test } from "node:test";
import { buildContext } from "../src/agent/context.js";
import { MAIN_LANE, type SessionEvent } from "../src/types.js";

/**
 * What happens when a run runs out of window.
 *
 * This is the failure that looked like a stubborn model: an agent read the
 * repository, read two CSV datasets, and then — having lost every earlier turn
 * to make room — started again from "let me list the folder". Twice. It was
 * not being stubborn; it could no longer see that it had done the work.
 */

let seq = 0;
const at = (body: SessionEvent["body"]): SessionEvent => ({
  seq: ++seq,
  ts: 1_700_000_000_000 + seq,
  actor: { id: "u-1", name: "Ada", kind: "human" },
  lane: MAIN_LANE,
  body,
});

/** An instruction only enters the context when it is delivered, so both events. */
const ask = (text: string): SessionEvent[] => {
  const said = at({ type: "instruction", text, interrupt: false });
  return [said, at({ type: "instructions.delivered", seqs: [said.seq] })];
};
const called = (id: string, name: string, args: Record<string, unknown>) =>
  at({ type: "agent.message", text: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const answered = (id: string, name: string, output: string) => at({ type: "tool.result", callId: id, name, output, isError: false });

test("one enormous tool result cannot swallow the window", () => {
  const huge = "row,of,csv\n".repeat(40_000);
  const msgs = buildContext(
    [...ask("look over the code"), called("c1", "read_file", { path: "dataset.csv" }), answered("c1", "read_file", huge)],
    { lane: MAIN_LANE },
  );

  const result = msgs.find((m) => m.role === "tool");
  assert.ok(result, "the result is still there");
  const text = String(result.content);
  assert.ok(text.length < huge.length / 10, `kept ${text.length} of ${huge.length} characters`);
  assert.match(text, /more characters/, "and says it was cut, rather than pretending that was the whole file");
});

test("when turns are dropped, the agent is told what it already did", () => {
  // Enough work to blow the window, each result big but under the per-result cap.
  const events: SessionEvent[] = [...ask("look over the code in the ml folder")];
  const files = ["alerting_policy.py", "auto_tune.py", "calibrate.py", "build_uwf_csv.py", "compare_operating_points.py"];
  files.forEach((path, i) => {
    events.push(called(`c${i}`, "read_file", { path }), answered(`c${i}`, "read_file", "x".repeat(18_000)));
  });

  // A window too small for all of it, so the oldest turns have to go.
  const msgs = buildContext(events, { lane: MAIN_LANE, budget: 40_000 });
  const note = msgs.map((m) => String(m.content)).find((c) => c.includes("were dropped from your context"));

  assert.ok(note, `a note about the cut: ${msgs.map((m) => m.role).join(",")}`);
  assert.match(note, /you already ran/, "naming the work is what stops it starting over");
  assert.match(note, /read_file\(alerting_policy\.py\)/, "with the arguments, so it knows which files");
  assert.match(note, /Don't run those again/);
});

test("a run that fits is left exactly as it is", () => {
  const events = [...ask("hello"), called("c1", "list_files", { path: "ml" }), answered("c1", "list_files", "a.py\nb.py")];
  const msgs = buildContext(events, { lane: MAIN_LANE });
  assert.equal(
    msgs.filter((m) => String(m.content).includes("were dropped")).length,
    0,
    "no note, because nothing was cut",
  );
  assert.equal(String(msgs.find((m) => m.role === "tool")?.content), "a.py\nb.py", "and the result is untouched");
});
