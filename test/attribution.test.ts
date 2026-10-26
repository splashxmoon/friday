import assert from "node:assert/strict";
import test from "node:test";
import { addedLines, attributionOf, byHand, handWord } from "../src/attribution.js";
import type { EventBody, SessionEvent } from "../src/types.js";

const AGENT = { id: "agent", name: "Claude Code", kind: "agent" as const };
const ADA = { id: "ada", name: "Ada", kind: "human" as const };
let seq = 0;
const ev = (body: EventBody, actor: SessionEvent["actor"] = AGENT): SessionEvent => ({ seq: ++seq, ts: 1_700_000_000_000 + seq, actor, body }) as SessionEvent;
const diff = (patch: string) => ev({ type: "agent.diff", base: "b", files: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 0, patch }] } as EventBody);

test("Attribution: lines an agent added during its run are its own; lines that appear between runs are the person's, named", () => {
  seq = 0;
  const events = [
    ev({ type: "run.started" } as EventBody),
    diff("@@ -1,2 +1,4 @@\n a\n+const x = 1;\n+const y = 2;\n b"),
    ev({ type: "run.ended", outcome: "done" } as EventBody),
    ev({ type: "folder.edited", path: "src/a.ts", bytes: 40 } as EventBody, ADA),
    diff("@@ -1,2 +1,5 @@\n a\n+const x = 1;\n+const y = 2;\n+const z = 3; // Ada's\n b"),
  ];
  const attr = attributionOf(events);
  assert.deepEqual([...attr.get("src/a.ts")!.human], ["const z = 3; // Ada's"]);
  assert.equal(attr.get("src/a.ts")!.by, "Ada");
  assert.ok(byHand(attr, "src/a.ts", "const z = 3; // Ada's"));
  assert.ok(!byHand(attr, "src/a.ts", "const x = 1;"));
  assert.equal(handWord(attr, "src/a.ts"), "1 line by hand (Ada)");
  assert.equal(handWord(attr, "src/other.ts"), "");
  // The agent's next run takes the file back: whatever it leaves is its own again.
  const more = [...events, ev({ type: "run.started" } as EventBody), diff("@@ -1,2 +1,5 @@\n a\n+const x = 1;\n+const y = 2;\n+const z = 3; // Ada's\n b"), ev({ type: "run.ended", outcome: "done" } as EventBody)];
  assert.equal(attributionOf(more).size, 0);
});

test("Attribution: a line changed by hand reads as by hand, a line the person removed leaves no mark, and a file gone from the change set is forgotten", () => {
  seq = 0;
  const events = [
    ev({ type: "run.started" } as EventBody),
    diff("@@ -1 +1,3 @@\n a\n+let n = 10;\n+let m = 20;"),
    ev({ type: "run.ended", outcome: "done" } as EventBody),
    diff("@@ -1 +1,2 @@\n a\n+let n = 12;"),
  ];
  const attr = attributionOf(events);
  assert.deepEqual([...attr.get("src/a.ts")!.human], ["let n = 12;"]);
  assert.equal(attr.get("src/a.ts")!.by, undefined, "nobody's save is in the log, so no name");
  const gone = [...events, ev({ type: "agent.diff", base: "b", files: [] } as EventBody)];
  assert.equal(attributionOf(gone).size, 0);
  assert.deepEqual(addedLines("+++ b/x\n+one\n-two\n+three"), ["one", "three"]);
});
