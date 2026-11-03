import assert from "node:assert/strict";
import test from "node:test";
import { cleanWorkflow, connectionsOf, stagesOf, stageCols, workflowChecks, workflowTasks, type WorkflowStep } from "../src/team-workflow-model.js";

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
