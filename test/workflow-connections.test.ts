import assert from "node:assert/strict";
import test from "node:test";
import { cleanWorkflow, connectionsOf, fixSteps, ifNotOf, ifNotTo, stagesOf, stageCols, workflowChecks, workflowTasks, type WorkflowStep } from "../src/team-workflow-model.js";

const steps: WorkflowStep[] = [
  { id: "plan", mate: "dev", does: "Plan", owns: [], col: 0 },
  { id: "implement", mate: "dev", does: "Implement", owns: [], col: 1 },
  { id: "review", mate: "qa", does: "Review", owns: [], col: 2, kind: "check", next: "finalize", otherwise: "fixes" },
  { id: "finalize", mate: "dev", does: "Finalize", owns: [], col: 3, next: "$finish" },
  { id: "fixes", mate: "fixer", does: "Prepare fixes", owns: [], col: 4, next: "implement" },
];
const clean = (s: WorkflowStep[]) => cleanWorkflow({ name: "Review branches", steps: s }, null, { secret: () => "test", schedule: () => undefined });
const team = { mates: ["dev", "qa", "fixer"].map(id => ({ id, name: id })), rooms: [], workflows: [] };

test("connections persist independently of step order, instructions and account ownership", () => {
  const w = clean(steps);
  assert.equal(w.steps[2]!.next, "finalize");
  assert.equal(w.steps[2]!.otherwise, "fixes");
  assert.equal(w.steps[4]!.mate, "fixer");
  assert.equal(w.steps[4]!.does, "Prepare fixes");
  assert.deepEqual(clean(JSON.parse(JSON.stringify(w.steps))), w);
  assert.deepEqual(workflowChecks({ ...w, id: "w" }, team), []);
  const edges = connectionsOf(w.steps);
  assert.ok(edges.some(e => e.source === "review" && e.port === "next" && e.target === "finalize"));
  assert.ok(edges.some(e => e.source === "review" && e.port === "otherwise" && e.target === "fixes"));
  assert.ok(!edges.some(e => e.source === "finalize" && e.target === "fixes"));
});

test("each branch ends at its explicit connection instead of running the other branch", () => {
  const w = clean(steps);
  assert.equal(stagesOf(w.steps).length, 3);
  assert.deepEqual(workflowTasks(w, id => id, "", 1).map(t => t.title), ["Finalize"]);
  assert.deepEqual(workflowTasks(w, id => id, "", 2).map(t => t.title), ["Prepare fixes"]);
  assert.deepEqual(stageCols(w.steps, 0, "implement").flat().map(s => s.id), ["implement", "review"]);
});

test("legacy workflows retain parallel dependencies and their existing retry destination", () => {
  const legacy: WorkflowStep[] = [
    { ...steps[0]!, col: 0 }, { ...steps[1]!, col: 0 },
    { ...steps[2]!, col: 1, next: undefined, otherwise: undefined, ifNot: "back", back: "implement", tries: 3, fixBy: "fixer" },
  ];
  const w = clean(legacy);
  const tasks = workflowTasks(w, id => id);
  assert.deepEqual(tasks[2]!.after, ["s1", "s2"]);
  assert.equal(w.steps[2]!.fixBy, "fixer");
  assert.ok(connectionsOf(w.steps).some(e => e.source === "review" && e.target === "implement" && e.port === "otherwise"));
});

test("deleted destinations stay visible as errors instead of silently choosing another route", () => {
  const w = clean(steps.filter(s => s.id !== "fixes"));
  assert.equal(w.steps[2]!.otherwise, "fixes");
  assert.ok(workflowChecks({ ...w, id: "w" }, team).some(c => c.level === "fix" && c.on === "review"));
});

test("routing steps stand alone while unrelated steps may still run in parallel", () => {
  const w = clean(steps.map(s => ({ ...s, col: 0 })));
  const cols = stagesOf(w.steps).flatMap(s => s.cols);
  assert.deepEqual(cols[0]!.map(s => s.id), ["plan", "implement"]);
  assert.ok(cols.filter(c => c.some(s => s.next)).every(c => c.length === 1));
});

test("invalid connection values are rejected and changing a check to work drops its failure route", () => {
  assert.throws(() => clean([{ ...steps[0]!, next: "x".repeat(25) }]), /connection/i);
  assert.throws(() => clean([{ ...steps[0]!, next: "$unknown" }]), /connection/i);
  assert.equal(clean([{ ...steps[2]!, kind: "do" }]).steps[0]!.otherwise, undefined);
});

test("free card positions round-trip alongside branch connections without changing execution order", () => {
  const input = { name: "Review branches", steps, layout: { review: { x: -220, y: 140 }, fixes: { x: 30, y: 360 }, trigger: { x: 0, y: -80 } } };
  const make = { secret: () => "test", schedule: () => undefined };
  const w = cleanWorkflow(input, null, make);
  const reopened = cleanWorkflow(JSON.parse(JSON.stringify(w)), null, make);
  assert.deepEqual(reopened.layout, input.layout);
  assert.deepEqual(reopened.steps.map(s => s.id), steps.map(s => s.id));
  assert.deepEqual(connectionsOf(reopened.steps), connectionsOf(steps));
  assert.deepEqual(workflowTasks(reopened, id => id, "", 2).map(t => t.title), ["Prepare fixes"]);
});

test("a check's FAIL wire and its If it doesn't pass are one setting: an earlier step is the send-back, a later one a path of its own", () => {
  const steps: WorkflowStep[] = [
    { id: "build", col: 0, mate: "m", does: "build", owns: [] },
    { id: "review", col: 1, mate: "q", does: "review", owns: [], kind: "check", ifNot: "stop", tries: 3 },
    { id: "fixes", col: 2, mate: "f", does: "fixes", owns: [], next: "build" },
  ];
  const gate = steps[1]!;
  // Back to an earlier step: the send-back it always was, its fixer kept.
  const back = ifNotTo(steps, { ...gate, fixBy: "f" }, "build");
  assert.deepEqual(back, { ifNot: "back", back: "build", otherwise: undefined });
  assert.equal(ifNotOf({ ...gate, ...back }), "build");
  // On to a later step: a path of its own, which says who does it, so no fixer.
  const path = ifNotTo(steps, { ...gate, fixBy: "f" }, "fixes");
  assert.deepEqual(path, { ifNot: "back", otherwise: "fixes", back: undefined, fixBy: undefined });
  assert.equal(ifNotOf({ ...gate, ...path }), "fixes");
  // Stopping clears both, so the canvas and the settings never disagree.
  for (const to of [undefined, "$finish"]) {
    const stop = ifNotTo(steps, { ...gate, ...path }, to);
    assert.deepEqual(stop, { ifNot: "stop", back: undefined, otherwise: undefined, fixBy: undefined });
    assert.equal(ifNotOf({ ...gate, ...path, ...stop }), undefined);
  }
  // Either way the runner's checks find nothing to fix, and the canvas draws one FAIL path.
  for (const change of [back, path]) {
    const wired = steps.map((s) => (s.id === "review" ? { ...s, ...change } : s));
    assert.equal(connectionsOf(wired).filter((c) => c.port === "otherwise").length, 1);
  }
});

test("a fix step is one added as one: a check's Fails dragged onto the next step on the line leaves that step on the line", () => {
  const base: WorkflowStep[] = [
    { id: "build", col: 0, mate: "dev", does: "build", owns: [] },
    { id: "review", col: 1, mate: "qa", does: "review", owns: [], kind: "check", ifNot: "stop", tries: 3 },
    { id: "ship", col: 2, mate: "dev", does: "ship", owns: [] },
    { id: "fixes", col: 3, mate: "fixer", does: "fixes", owns: [], fixFor: "review" },
  ];
  const onto = (target: string) => base.map((s) => (s.id === "review" ? { ...s, ...ifNotTo(base, s, target) } : s));
  // Onto the next step: a jump there; "ship" stays on the line, so passing still goes to it.
  const jumped = onto("ship");
  assert.ok(!fixSteps(jumped).has("ship"));
  assert.equal(connectionsOf(jumped).find((c) => c.source === "review" && c.port === "next")?.target, "ship");
  assert.ok(workflowChecks({ ...clean(jumped), id: "w" }, team).some((c) => /same step whether it passes/.test(c.text)));
  // The fix step it was added as stays off the line, and is flagged as no longer sent anything.
  assert.ok(fixSteps(jumped).has("fixes"));
  assert.ok(workflowChecks({ ...clean(jumped), id: "w" }, team).some((c) => c.on === "fixes" && /no longer sends work/.test(c.text)));
  // Sent to itself: something to fix before it runs.
  const self = base.map((s) => (s.id === "review" ? { ...s, ifNot: "back" as const, otherwise: "review" } : s));
  assert.ok(workflowChecks({ ...clean(self), id: "w" }, team).some((c) => c.level === "fix" && /to itself/.test(c.text)));
});
