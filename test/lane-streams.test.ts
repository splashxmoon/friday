import assert from "node:assert/strict";
import test from "node:test";
import { eventsAfterHello, sinceFor, streamsAfter, type Streams } from "../src/client/useSession.js";
import type { SessionEvent } from "../src/types.js";

test("a page holding the log whole asks only for what came after it, and adds that to what it holds", () => {
  const evs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: from + i }) as SessionEvent);
  assert.equal(sinceFor([]), undefined, "nothing held: the whole log");
  assert.equal(sinceFor(evs(1, 5)), 5);
  assert.equal(sinceFor(evs(3, 5)), undefined, "a log not held from its start asks for all of it");
  // A newer server answers with `since`; the events are what came after it.
  assert.deepEqual(eventsAfterHello(evs(1, 5), { events: evs(6, 7), since: 5 }).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  // An older server ignores `since` and sends the whole log, which replaces what is held.
  assert.deepEqual(eventsAfterHello(evs(1, 5), { events: evs(1, 7) }).map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
});

/** What each agent is typing right now. Two agents at once are two streams, never one jumbled one. */

const delta = (text: string, lane?: string, channel?: "text" | "reasoning") => ({ kind: "delta" as const, text, ...(lane ? { lane } : {}), ...(channel ? { channel } : {}) });
const event = (type: string, lane?: string) => ({ kind: "event" as const, event: { ...(lane ? { lane } : {}), body: { type } } });
const feed = (msgs: Parameters<typeof streamsAfter>[1][], from: Streams = {}) => msgs.reduce(streamsAfter, from);

test("each agent's words go to its own stream", () => {
  const s = feed([delta("Hel"), delta("SEO: a", "seo"), delta("lo"), delta("udit", "seo")]);
  assert.deepEqual(s.main, { text: "Hello", reasoning: "" });
  assert.deepEqual(s.seo, { text: "SEO: audit", reasoning: "" });
});

test("thinking is kept apart from the answer, per agent", () => {
  const s = feed([delta("hmm ", "seo", "reasoning"), delta("answer", "seo"), delta("main thinks", undefined, "reasoning")]);
  assert.deepEqual(s.seo, { text: "answer", reasoning: "hmm " });
  assert.deepEqual(s.main, { text: "", reasoning: "main thinks" });
});

test("one agent finishing closes only its own stream", () => {
  const typing = feed([delta("main words"), delta("seo words", "seo")]);
  for (const type of ["agent.message", "run.ended", "run.pause", "run.cancel"]) {
    const after = streamsAfter(typing, event(type, "seo"));
    assert.equal(after.seo, undefined, `${type} closes the seo stream`);
    assert.equal(after.main?.text, "main words", `${type} leaves main typing`);
  }
});

test("the main agent finishing leaves the others typing", () => {
  const after = streamsAfter(feed([delta("m"), delta("s", "seo")]), event("agent.message"));
  assert.equal(after.main, undefined);
  assert.equal(after.seo?.text, "s");
});

test("other events change nothing", () => {
  const typing = feed([delta("a"), delta("b", "seo")]);
  assert.equal(streamsAfter(typing, event("instruction", "seo")), typing);
  assert.equal(streamsAfter(typing, event("control.granted")), typing);
});

test("a stream can start again after it was closed", () => {
  const s = feed([delta("one", "seo"), event("agent.message", "seo"), delta("two", "seo")]);
  assert.equal(s.seo?.text, "two");
});
