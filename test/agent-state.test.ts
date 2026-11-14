// One agent's state, worked out once for every view and every person (agent-state.ts; audit B-14, B-18, B-19, B-35), the
// sidebar's per-person rows and Needs you built on it (attention.ts), and each Friday agent's own face (agent-face.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { agentLine, agentState, heldOn, phaseRing, plainError, saysItAll, waitingWord } from "../src/agent-state.js";
import { attentionIn, crewOf } from "../src/attention.js";
import { faceIndex, FACES } from "../src/agent-face.js";
import type { SessionState } from "../src/session/projection.js";

const ADA = "u-ada";
const BEA = "u-bea";
const CY = "u-cy";

const session = (over: Partial<SessionState> = {}): SessionState =>
  ({
    id: "s1",
    title: "Saved carts",
    ownerId: ADA,
    workspaceId: "w1",
    lastSeq: 40,
    members: { [ADA]: { name: "Ada Lovelace", role: "owner" }, [BEA]: { name: "Bea Barnes", role: "editor" }, [CY]: { name: "Cy Young", role: "viewer" } },
    driver: { id: ADA, name: "Ada Lovelace" },
    pendingRequests: [],
    run: { status: "idle", sinceSeq: 0 },
    openQuestions: {},
    lanes: [],
    laneRuns: {},
    laneDrivers: {},
    approvals: {},
    asks: {},
    engines: {},
    options: { agent: null, approvers: 1, policy: { editor: { control: true, suggest: true }, viewer: { control: false, suggest: false } } },
    ...over,
  }) as unknown as SessionState;

const askAda = { main: { seq: 12, lane: "main", question: "Keep guest carts, or merge them?", to: ADA, toName: "Ada Lovelace" } };

test("a question to Ada needs Ada, and everyone else sees it waiting on Ada, quietly (B-14)", () => {
  const s = session({ run: { status: "waiting_for_human", sinceSeq: 12 } as never, openQuestions: askAda });
  const ada = agentState(s, "main", ADA);
  assert.deepEqual([ada.phase, ada.word, ada.needsYou], ["needs", "Needs you", true]);
  for (const who of [BEA, CY]) {
    const them = agentState(s, "main", who);
    assert.deepEqual([them.phase, them.word, them.needsYou], ["waiting", "Waiting on Ada", false]);
    assert.equal(phaseRing(them), "queued", "never amber for somebody it isn't waiting on");
  }
  assert.equal(phaseRing(ada), "needs");
  assert.deepEqual(heldOn(s, "main"), { kind: "question", ids: [ADA], names: ["Ada"] });
});

test("an approval waits on whoever is in control, else the owners, else only its machine's host", () => {
  const ask = { main: { id: "k", seq: 14, scope: "commands", items: ["npm run db:migrate"] } };
  const driving = session({ approvals: ask as never, driver: { id: BEA, name: "Bea Barnes" } });
  assert.equal(agentState(driving, "main", BEA).needsYou, true);
  assert.equal(agentState(driving, "main", ADA).word, "Waiting on Bea", "the owner isn't who it waits on while Bea drives");
  const free = session({ approvals: ask as never, driver: null });
  assert.equal(agentState(free, "main", ADA).needsYou, true, "nobody in control: the owner's");
  assert.equal(agentState(free, "main", BEA).word, "Waiting on Ada");
  const manual = session({ approvals: ask as never, engines: { main: { tool: "claude", hostId: CY, hostName: "Cy Young", mode: "edits", online: true } } as never });
  assert.equal(agentState(manual, "main", ADA).word, "Waiting on Cy", "a Manual machine: only its host says yes");
  // Several yeses on one ask are the hosted edition's (approvalsNeeded); the open-source edition has one person.
});

test("a failed run reads the same for everyone: Hit an error, in plain words, the provider's text kept; retry is the controller's and the owner's (B-18, B-19, B-35)", () => {
  const s = session({ driver: { id: BEA, name: "Bea Barnes" }, run: { status: "error", sinceSeq: 20, error: "429 rate limit exceeded for model" } as never });
  const views = [ADA, BEA, CY].map((id) => agentState(s, "main", id));
  for (const v of views) {
    assert.equal(v.phase, "failed", "a passing per-minute 429 is an error to try again, not out of usage");
    assert.equal(v.word, "Hit an error");
    assert.deepEqual(v.error, { plain: "too many requests, try again in a minute", raw: "429 rate limit exceeded for model" });
  }
  assert.deepEqual(views[0]!.retry, { mine: true }, "the owner");
  assert.deepEqual(views[1]!.retry, { mine: true }, "in control");
  assert.deepEqual(views[2]!.retry, { mine: false, ask: "Bea" }, "anyone else asks whoever is in control");
  assert.equal(agentLine("Rio", views[2]!), "Rio hit an error · too many requests, try again in a minute");
  assert.deepEqual(agentState(session({ driver: null, run: s.run }), "main", BEA).retry, { mine: false, ask: "Ada" }, "nobody in control: ask the owner");
  assert.equal(phaseRing(views[0]!), "error");
});

test("out of usage until it lifts, ready once it has; carried on by another agent is nothing stopped", () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const limited = session({ run: { status: "error", sinceSeq: 20, sinceAt: now - 60_000, error: "You've hit your usage limit. Try again in 2 hours." } as never });
  const a = agentState(limited, "main", CY, { now });
  assert.deepEqual([a.phase, a.word, a.until], ["limited", "Out of usage", now - 60_000 + 2 * 3_600_000]);
  assert.equal(phaseRing(a), "limited");
  assert.equal(agentState(limited, "main", CY, { now: now + 3 * 3_600_000 }).phase, "ready", "lifted");
  const carried = session({ ...limited, lanes: [{ id: "codex", name: "Codex" }] as never, laneRuns: { codex: { status: "running", sinceSeq: 30 } } as never });
  assert.equal(agentState(carried, "main", ADA, { now }).phase, "ready");
});

test("the quiet states: working, paused, offline (unless its computer is linked), stopped, stopped short (amber only for whoever steers), done, ready", () => {
  assert.equal(agentState(session({ run: { status: "running", sinceSeq: 3 } as never }), "main", CY).word, "Working");
  assert.equal(agentState(session({ run: { status: "paused", sinceSeq: 3 } as never }), "main", CY).word, "Paused");
  const away = session({ engines: { main: { tool: "claude", hostId: ADA, hostName: "Ada", online: false } } as never });
  assert.equal(agentState(away, "main", CY).word, "Offline");
  assert.equal(agentState(away, "main", CY, { hostUp: () => true }).word, "Ready");
  assert.equal(agentState(session({ stopped: { main: 9 } } as never), "main", CY).word, "Stopped");
  const short = session({ finished: { main: 9 }, planDone: { main: { done: 3, of: 5 } } } as never);
  assert.deepEqual([agentState(short, "main", ADA).word, phaseRing(agentState(short, "main", ADA))], ["Stopped at 3 of 5", "needs"]);
  assert.equal(phaseRing(agentState(short, "main", CY)), null, "not Cy's to carry on");
  assert.equal(agentState(session({ finished: { main: 9 } } as never), "main", CY).word, "Done");
  assert.equal(agentState(session(), "main", CY).word, "Ready");
});

test("plain words for a provider's errors, the short plain ones kept as they are", () => {
  assert.equal(plainError("The folder disconnected."), "the folder disconnected");
  assert.equal(saysItAll("The folder disconnected."), true, "nothing more to show behind a toggle");
  assert.equal(plainError("node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module 'x'"), "its tool didn't start");
  assert.equal(plainError("Error: 529 overloaded_error"), "its model's service had a problem");
  assert.equal(plainError("Error: socket hang up"), "it lost its connection");
  assert.equal(plainError("TypeError: Cannot read properties of undefined (reading 'x')\n    at run (/srv/a.js:3:9)"), "something went wrong");
  assert.equal(plainError(""), "it stopped without saying why");
  assert.equal(saysItAll("429 rate limit exceeded for model"), false);
  assert.equal(waitingWord({ kind: "question", ids: [ADA, BEA, CY], names: ["Ada", "Bea", "Cy"] }), "Waiting on Ada and 2 others");
});

test("the sidebar's rows and Needs you are per person: only Ada's says needs you for a question to Ada (B-14)", () => {
  const s = session({ run: { status: "waiting_for_human", sinceSeq: 12 } as never, openQuestions: askAda });
  const row = (id: string) => crewOf(s, undefined, id)!.agents[0]!;
  assert.deepEqual([row(ADA).state, row(ADA).word, row(ADA).you], ["needs", "Needs you", true]);
  assert.deepEqual([row(BEA).state, row(BEA).word, row(BEA).you], ["waiting", "Waiting on Ada", undefined]);
  assert.equal(row(CY).word, "Waiting on Ada", "the same words for Bea and Cy");
  assert.equal(attentionIn(s, ADA).length, 1);
  assert.equal(attentionIn(s, BEA).length, 0, "not counted for Bea");
  assert.equal(attentionIn(s, CY).length, 0);
  // An approval while Bea drives is Bea's to answer, not the owner's.
  const ask = session({ driver: { id: BEA, name: "Bea Barnes" }, approvals: { main: { id: "k", seq: 14, scope: "commands", items: ["git push"] } } as never });
  assert.deepEqual([attentionIn(ask, BEA).map((a) => a.kind), attentionIn(ask, ADA).length], [["approval"], 0]);
  // A failed run is the controller's to try again: on their list, in the same words as the row.
  const failed = session({ driver: { id: BEA, name: "Bea Barnes" }, run: { status: "error", sinceSeq: 20, error: "429 rate limit exceeded for model" } as never });
  assert.equal(attentionIn(failed, BEA)[0]!.text, "Hit an error · too many requests, try again in a minute");
  assert.equal(crewOf(failed, undefined, CY)!.agents[0]!.plain, "too many requests, try again in a minute");
});

test("each Friday agent wears a face of its own, the same everywhere and kept when others join (B-20)", () => {
  const lanes = (ids: string[]) => ({ lanes: ids.map((id) => ({ id })) }) as never;
  assert.equal(faceIndex(lanes([]), "main"), 0, "the session's own agent is Friday's");
  const two = lanes(["juno"]);
  assert.notEqual(faceIndex(two, "juno"), 0, "Juno doesn't look like Friday Code");
  const many = lanes(["juno", "rio", "kit", "max"]);
  const faces = ["main", "juno", "rio", "kit", "max"].map((l) => faceIndex(many, l));
  assert.equal(new Set(faces).size, faces.length, "no two alike while there are faces to go round");
  assert.equal(faceIndex(many, "juno"), faceIndex(two, "juno"), "a later agent doesn't change Juno's");
  assert.ok(faces.every((f) => FACES[f]), "every face is one of the set");
});
