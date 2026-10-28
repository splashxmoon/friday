import assert from "node:assert/strict";
import test from "node:test";
import { asksToStop, heldByPerson, runnableQueue, saysHolding } from "../src/held.js";
import { MAIN_LANE, type SessionEvent } from "../src/types.js";

let seq = 0;
const ask = (text: string, lane = MAIN_LANE) => ({ seq: ++seq, ts: seq, lane, actor: { id: "u", name: "Arun", kind: "human" }, body: { type: "instruction", text, interrupt: false } }) as unknown as SessionEvent;
const said = (text: string, lane = MAIN_LANE) => ({ seq: ++seq, ts: seq, lane, actor: { id: "agent", name: "Manager", kind: "agent" }, body: { type: "agent.message", text, toolCalls: [] } }) as unknown as SessionEvent;

test("a message that is itself a stop puts an agent on hold; one that only uses the word doesn't", () => {
  for (const t of ["stop", "Pause your work", "@Nih @Gato pause your work", "everyone stop until I say", "hold on for now", "Everyone, please pause.", "ok stop everything", "Ok, now everyone stop.", "everyone stop and wait for me"]) assert.ok(asksToStop(t), t);
  // Missed before (2026-10-27 audit): the stop on its own, with its reason after it, said again and again, or till the person is back.
  for (const t of ["stop it", "Stop, that's wrong", "STOP STOP STOP", "Pause everything until I'm back", "@Nova stop that", "hold on, let me check something"]) assert.ok(asksToStop(t), t);
  for (const t of ["stop at the first failing test and fix it", "Stop using the old API, call v2", "wait for the build, then deploy", "don't stop until the tests pass", "pause the video at 0:12 and screenshot it", "everyone stop using tabs"]) assert.ok(!asksToStop(t), t);
  // Read as a stop to everyone before (2026-10-27 audit): each has the stop's object, or another task, after it. A hold on one
  // thing ("hold off on the deploy") is the same: the rest of the work goes on.
  for (const t of [
    "Everyone stop what you're doing and fix the failing build",
    "everyone, stop editing main.ts, Nova owns it",
    "Everyone pause the refactor and look at the prod bug first",
    "Everyone, keep going, but don't stop the dev server",
    "Everybody stop by the standup channel at 9",
    "y'all stop pushing to main directly",
    "all of you hold off on the deploy",
  ])
    assert.ok(!asksToStop(t), t);
});

test("an agent's own words that it is holding as told", () => {
  assert.ok(saysHolding("I'm still stopped. arundass ordered everyone to stop, and I found no message lifting that order."));
  assert.ok(saysHolding("Nothing new. I'm still holding because you asked everyone to stop until you say to resume."));
  assert.ok(saysHolding("Still stopped, as you asked."));
  assert.ok(saysHolding("Holding until you say go."));
  assert.ok(!saysHolding("Holding the file lock while I edit, then I'll release it."));
  // Waiting on a teammate, or stopped by something, isn't holding as told (2026-10-27 audit: each was read as it).
  for (const t of [
    "I'll wait for Nova to say the schema is merged, then wire the client.",
    "I'm not writing tests for this since they already exist.",
    "We're stopped by a failing typecheck in src/api.ts; fixing it now.",
    "I'm standing by for Kit's review.",
    "I'm not carrying on with the deploy because the tests fail.",
  ])
    assert.ok(!saysHolding(t), t);
});

test("on hold until a person says otherwise: to it, or to everyone", () => {
  const lead = "lead";
  const nih = "nih";
  const told = [ask("everyone stop until I say", lead)];
  assert.ok(heldByPerson(told, lead));
  assert.ok(heldByPerson(told, nih), "a stop to everyone reaches every agent, through the lead");
  assert.ok(!heldByPerson([...told, ask("everyone carry on", lead)], nih), "and a later word to everyone lifts it");
  assert.ok(!heldByPerson([...told, ask("go ahead with S5", nih)], nih), "or one to it");
  // The Manager's loop: everyone told to stop, and nothing from a person since, so Friday leaves it.
  assert.ok(heldByPerson([ask("Run S4", lead), ask("everyone stop", MAIN_LANE), said("I'm still stopped because you asked everyone to stop.", lead)], lead));
  assert.ok(!heldByPerson([said("I'm still stopped because you asked everyone to stop.", lead), ask("resume the board", lead)], lead));
  assert.ok(!heldByPerson([ask("fix the checkout total")], MAIN_LANE));
  // Its own holding words count only when they answer a stop: the person's last word to it was work (2026-10-27 audit).
  assert.ok(!heldByPerson([ask("Run S4", lead), said("I'm still stopped because you asked everyone to stop.", lead)], lead));
  // A message that mentions everyone isn't to everyone: it neither stops nor lifts the others' hold (2026-10-27 audit).
  assert.ok(heldByPerson([ask("stop", nih), ask("@Kit, everyone is waiting on you", lead)], nih));
  assert.ok(!heldByPerson([ask("@Kit, everyone stop by the release channel", lead)], nih));
});

test("a stop from the team's lead holds a teammate once it says it is holding as told; the person's word lifts it", () => {
  const nova = "nova";
  const kit = "kit";
  const lead = { seq: ++seq, ts: seq, lane: MAIN_LANE, actor: { id: "u", name: "Arun", kind: "human" }, body: { type: "lead.set", lane: nova } } as unknown as SessionEvent;
  const fromNova = (text: string) => ({ seq: ++seq, ts: seq, lane: kit, actor: { id: "agent", name: "Nova", kind: "agent" }, body: { type: "instruction", text, interrupt: false, mesh: { id: "m", kind: "tell", fromLane: nova, fromName: "Nova", toName: "Kit", hop: 1, by: null } } }) as unknown as SessionEvent;
  const stop = [lead, fromNova("Kit, stop.")];
  assert.ok(!heldByPerson(stop, kit), "not until it says so");
  assert.ok(heldByPerson([...stop, said("Stopped, as Nova asked.", kit)], kit));
  assert.ok(!heldByPerson([...stop, said("Stopped, as Nova asked.", kit), ask("carry on with the FAQ", kit)], kit));
  // A teammate's message that isn't the lead's is never a stop.
  const juno = { ...fromNova("stop"), seq: ++seq, body: { type: "instruction", text: "stop", interrupt: false, mesh: { id: "m2", kind: "tell", fromLane: "juno", fromName: "Juno", toName: "Kit", hop: 1, by: null } } } as unknown as SessionEvent;
  assert.ok(!heldByPerson([lead, juno, said("Stopped, as Juno asked.", kit)], kit));
});

test("on hold, what the other agents and Friday queue for it waits; a person's message goes, and takes it all with it", () => {
  const kit = "kit";
  const friday = (text: string) => ({ seq: ++seq, ts: seq, lane: kit, actor: { id: "friday", name: "Friday", kind: "system" }, body: { type: "instruction", text, interrupt: false } }) as unknown as SessionEvent;
  const stop = ask("stop", kit);
  const note = friday("[Check-in] Stand-up");
  assert.deepEqual(runnableQueue([stop, note], kit, [note.seq]), [], "held: Friday's check-in waits");
  const go = ask("carry on", kit);
  assert.deepEqual(runnableQueue([stop, note, go], kit, [note.seq, go.seq]), [note.seq, go.seq], "the person's word goes, and the check-in with it");
  assert.deepEqual(runnableQueue([note], kit, [note.seq]), [note.seq], "not held: as before");
});

