import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentMesh, factsOf, reviewSaid, reviewVerdict, WRITES } from "../src/agent-mesh.js";
import { reviewTally } from "../src/client/TeamPlan.js";
import { boardReportText } from "../src/client/team-room.js";
import { project, reviewApproved } from "../src/session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "../src/types.js";

/**
 * Reviews that say what happened (Arun, 2026-11-11: "if every review comes back approved, it's a second agent agreeing with the
 * first. does the board show rejected work anywhere?"). In his crews, reviewers approved 14 and sent back 2, and Friday passed 30
 * tasks as "Nothing changed to check" with no second agent, at least 8 of them real code changes made outside the agent's folder.
 * Now: work changed anywhere gets its review, a review with no verdict is asked again rather than passed, every round is kept, and
 * the plan counts approvals, send-backs and passes without a review apart.
 */

const ADA = { id: "u-ada", name: "Ada" };
const human: ActorRef = { ...ADA, kind: "human" };
const bot = (name: string): ActorRef => ({ id: "agent", name, kind: "agent" });

function memory() {
  const events: SessionEvent[] = [];
  const store = {
    async state() {
      return project("s", events);
    },
    async events() {
      return events;
    },
    async exists() {
      return events.length > 0;
    },
    async append(_sid: string, actor: ActorRef, body: EventBody, opts: { lane?: string } = {}) {
      const seq = events.length + 1;
      events.push({ seq, ts: Date.now(), actor, body, ...(opts.lane && opts.lane !== MAIN_LANE ? { lane: opts.lane } : {}) } as SessionEvent);
      return { ok: true as const, seq };
    },
  };
  const mesh = new AgentMesh(store as never, { wake: async () => {} } as never);
  const add = (body: EventBody, lane?: string, actor: ActorRef = human) => store.append("s", actor, body, lane ? { lane } : {});
  return { events, store, mesh, add };
}
async function team() {
  const m = memory();
  await m.add({ type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name });
  for (const [id, name] of [["lb", "Builder"], ["lw", "Writer"]] as const) await m.add({ type: "lane.added", lane: { id, name, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } } as EventBody);
  await m.mesh.postTasks("s", MAIN_LANE, [{ id: "a", title: "Fix the login", detail: "a", agent: "builder" }]);
  return m;
}
const task = async (m: Awaited<ReturnType<typeof team>>) => (await m.store.state()).board!.tasks.find((t) => t.id === "a")!;
const call = (name: string, args: Record<string, unknown>) => ({ id: `c${Math.random()}`, name, arguments: JSON.stringify(args) });

test("a review's verdict: approved, sent back, or neither, which is no verdict rather than an approval", () => {
  assert.equal(reviewVerdict("Approved. Clean change."), "pass");
  assert.equal(reviewVerdict("Approved I read Teddy's diff in integrate-r3"), "pass");
  assert.equal(reviewVerdict("The fix is correct and nothing was missed. Approved."), "pass", "approved as a sentence of its own");
  assert.equal(reviewVerdict("No problems found; the tests pass."), "pass");
  assert.equal(reviewVerdict("Changes needed: Craw hasn't done this task yet, so there's nothing to approve."), "fail");
  assert.equal(reviewVerdict("Found a problem: a double tap creates two charges."), "fail");
  // From Arun's crews: both had passed as approvals.
  assert.equal(reviewVerdict(""), "unclear");
  assert.equal(reviewVerdict("I'm still holding: arundass told everyone to stop and said we'll resume later."), "unclear");
  assert.equal(reviewVerdict("Manager's g-deploy patch is right. Leaving out kiosk.html was the correct call."), "unclear");
});

test("a command that changes files is told from one that only reads", () => {
  for (const c of ["cd site && sed -i '' 's/a/b/' src/AppUI.jsx", "python3 - <<'EOF'\ns=open(p).read(); open(p,'w').write(s)\nEOF", "git commit -m fix", "git -C repo apply t.patch", "echo hi > out.txt", "cat <<'EOF' > src/a.ts", "perl -pi -e 's/a/b/' x.js", "printf x | tee src/x.js"])
    assert.ok(WRITES.test(c), c);
  for (const c of ["sed -n '1,20p' a.js", "node --test test/ 2>&1 | grep pass", "npx tsc --noEmit 2>&1 | tail", "git diff -- DEPLOY.md", "npm test > /tmp/log.txt", "grep -rn x . > /dev/null", "node -e 'const f = () => 1'", "git status --porcelain"])
    assert.ok(!WRITES.test(c), c);
});

test("Friday's record of a task says no files changed only when nothing shows a change: not edits outside its folder, writing commands or a commit", async () => {
  const facts = async (bodies: EventBody[]) => {
    const m = await team();
    const got = m.events.findLast((e) => e.body.type === "board.claimed")!;
    for (const b of bodies) await m.add(b, "lb", bot("Builder"));
    return factsOf(await m.store.state(), m.events, "lb", got, m.events.at(-1)!);
  };
  assert.match(await facts([]), /^\[Friday, from the record\] no files changed/);
  const outside = await facts([{ type: "agent.message", text: "", toolCalls: [call("edit", { path: "/Users/a/edge/server/index.js" })] } as EventBody]);
  assert.match(outside, /nothing changed in its folder, but it edited 1 file outside it: \/Users\/a\/edge\/server\/index\.js/);
  assert.doesNotMatch(outside, /no files changed/);
  const codex = await facts([{ type: "agent.message", text: "", toolCalls: [call("edit", { path: "/r/a.js, /r/b.js" })] } as EventBody]);
  assert.match(codex, /edited 2 files outside it: \/r\/a\.js, \/r\/b\.js/, "a Codex change names its files together");
  const shell = await facts([{ type: "agent.message", text: "", toolCalls: [call("shell", { command: "sed -i '' 's/x/y/' src/AppUI.jsx" })] } as EventBody]);
  assert.match(shell, /ran commands that change files: sed -i/);
  const committed = await facts([{ type: "folder.committed", sha: "abcdef1234", message: "fix" } as EventBody]);
  assert.match(committed, /its changes are committed · .*committed abcdef1/);
  const both = await facts([
    { type: "agent.message", text: "", toolCalls: [call("edit", { path: "/w/b/src/a.js" }), call("edit", { path: "/elsewhere/c.js" })] } as EventBody,
    { type: "agent.diff", base: "b0", files: [{ path: "src/a.js", status: "modified", additions: 3, deletions: 1 }] } as EventBody,
  ]);
  assert.match(both, /1 file changed: src\/a\.js \+3 −1, and it edited 1 outside its folder: \/elsewhere\/c\.js/);
});

test("work changed outside its folder gets a second agent's review; Friday passes it alone only when its record says nothing changed", async () => {
  const run = async (report: string, bodies: EventBody[]) => {
    const m = await team();
    for (const b of bodies) await m.add(b, "lb", bot("Builder"));
    await m.mesh.finish("s", "lb", "a", report, false);
    return { t: await task(m), asked: m.events.some((e) => e.body.type === "board.review" && e.body.lane) };
  };
  const nothing = await run("Read it through; nothing to change.", []);
  assert.deepEqual([nothing.t.status, nothing.t.review?.auto, nothing.asked], ["done", true, false]);
  assert.equal(reviewApproved(nothing.t.review), false, "Friday's pass isn't an approval");
  const elsewhere = await run("Fixed the three issues.", [{ type: "agent.message", text: "", toolCalls: [call("edit", { path: "/Users/a/edge/server/index.js" })] } as EventBody]);
  assert.deepEqual([elsewhere.t.status, elsewhere.asked], ["review", true], "the edit outside its folder is read by Writer");
  const byShell = await run("Done.", [{ type: "agent.message", text: "", toolCalls: [call("shell", { command: "cd /site && sed -i '' 's/a/b/' src/AppUI.jsx" })] } as EventBody]);
  assert.equal(byShell.asked, true);
  // The agent's own words saying so don't let it through: only Friday's record does.
  const said = await run("Dass's part is right: no files changed there. I rewrote the client.", [{ type: "agent.diff", base: "b0", files: [{ path: "src/a.js", status: "modified", additions: 900, deletions: 4 }] } as EventBody]);
  assert.equal(said.asked, true);
});

test("a review with no verdict is asked for one again, then passes as no verdict, never as an approval", async () => {
  const m = await team();
  await m.add({ type: "agent.diff", base: "b0", files: [{ path: "src/a.js", status: "modified", additions: 900, deletions: 4 }] } as EventBody, "lb", bot("Builder"));
  await m.mesh.finish("s", "lb", "a", "Done: fixed the login.", false);
  assert.equal((await task(m)).reviewer?.lane, "lw");
  const turn = async (text: string) => {
    const seqs = (await m.store.state()).lanePending.lw ?? [];
    await m.add({ type: "run.started", causedBy: seqs[0] ?? 0 }, "lw", bot("Writer"));
    await m.add({ type: "instructions.delivered", seqs }, "lw", bot("Writer"));
    await m.add({ type: "agent.message", text, toolCalls: [] } as EventBody, "lw", bot("Writer"));
    await m.add({ type: "run.ended", outcome: "done" }, "lw", bot("Writer"));
    await m.mesh.onRunEnded("s", "lw");
  };
  await turn("I'm still holding until we resume.");
  assert.ok(!m.events.some((e) => e.body.type === "board.reviewed"), "not passed");
  const again = m.events.findLast((e) => e.lane === "lw" && e.body.type === "instruction");
  assert.match(again?.body.type === "instruction" ? again.body.text : "", /You didn't give a verdict on Builder's work on "Fix the login"\. End your turn with "Approved"/);
  assert.equal((await task(m)).status, "review");
  // Asked twice and still nothing: it goes through, said as no verdict.
  await turn("Looked at it.");
  const t = await task(m);
  assert.deepEqual([t.status, t.review?.unclear, reviewApproved(t.review)], ["done", true, false]);
  assert.equal(reviewSaid(t.review!), "passed with no verdict from Writer");
});

test("every review round is kept, send-backs counted apart from failed checks, and the plan's tally tells approvals from passes without a review", () => {
  const ev = (body: EventBody, lane?: string): SessionEvent => ({ seq: 0, ts: 1, actor: bot("x"), body, ...(lane ? { lane } : {}) }) as SessionEvent;
  const events = [
    ev({ type: "session.created", title: "t", ownerId: ADA.id, ownerName: ADA.name }),
    ev({ type: "board.posted", fromLane: MAIN_LANE, fromName: "Main", tasks: [{ id: "a", title: "A", detail: "a", after: [], owns: [] }, { id: "b", title: "B", detail: "b", after: [], owns: [] }] } as unknown as EventBody),
    ev({ type: "board.claimed", id: "a", lane: "lb", name: "Builder" }),
    ev({ type: "board.finished", id: "a", lane: "lb", name: "Builder", status: "done", report: "r" }),
    ev({ type: "board.checked", id: "a", lane: "lb", command: "npm test", ok: false, output: "1 failing" } as EventBody),
    ev({ type: "board.finished", id: "a", lane: "lb", name: "Builder", status: "done", report: "r" }),
    ev({ type: "board.reviewed", id: "a", lane: "lw", name: "Writer", ok: false, note: "Changes needed: the token check is missing." }),
    ev({ type: "board.finished", id: "a", lane: "lb", name: "Builder", status: "done", report: "r" }),
    ev({ type: "board.reviewed", id: "a", lane: "lw", name: "Writer", ok: true, note: "Approved." }),
    ev({ type: "board.claimed", id: "b", lane: "lw", name: "Writer" }),
    ev({ type: "board.finished", id: "b", lane: "lw", name: "Writer", status: "done", report: "r" }),
    ev({ type: "board.reviewed", id: "b", lane: "", name: "Friday", ok: true, note: "Nothing changed to check." }),
  ].map((e, i) => ({ ...e, seq: i + 1 }));
  const s = project("s", events);
  const a = s.board!.tasks.find((t) => t.id === "a")!;
  assert.deepEqual(a.reviews?.map((r) => [r.by, r.ok]), [["Writer", false], ["Writer", true]], "the send-back's note stays after the approval");
  assert.deepEqual([a.rounds, a.backs], [2, { checks: 1, review: 1 }]);
  const tally = reviewTally(s.board!.tasks);
  assert.deepEqual(tally, { by: [{ name: "Writer", ok: 1, back: 1 }], approved: 1, back: 1, auto: 1, unclear: 0, checks: 1 });
  // The lead's report says which was a review.
  const text = boardReportText("## a: A\n## b: B", events, 999, () => undefined);
  assert.match(text, /## A \(done by Builder, approved by Writer\)/);
  assert.match(text, /## B \(done by Writer, passed without a review\)/);
});
