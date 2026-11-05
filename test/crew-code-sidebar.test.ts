// Code's sidebar leaves every Crew session out, from the first draw (Arun, 2026-11-04: "WHY ARE CREW SESSIONS APPEARING IN THE
// CODE SESSIONS SIDE BAR"): before the team's first read lands it had nothing to tell a Crew room by, and a room's own id was
// never asked about.
import assert from "node:assert/strict";
import test from "node:test";

test("Crew sessions are told apart before the team loads, and a room by its own id", async () => {
  const store = new Map<string, string>([["friday.crew.sids", JSON.stringify(["crew-home", "room-old"])]]);
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const team = { sid: "crew-home", hidden: ["crew-home", "mate-1"], rooms: [{ sid: "room-new", name: "Marketing" }], teammates: [] };
  (globalThis as { fetch?: unknown }).fetch = async () => new Response(JSON.stringify(team), { status: 200, headers: { "content-type": "application/json" } });
  const { isTeamSid, refreshTeam } = await import("../src/client/Teammates.js");

  // At startup, before /api/teammates has answered: what this page saw last time is left out already.
  assert.equal(isTeamSid("crew-home"), true, "the Crew room");
  assert.equal(isTeamSid("room-old"), true, "a room seen before");
  assert.equal(isTeamSid("code-1"), false, "a Code session stays");

  await refreshTeam({ id: "u", name: "Arun" } as never);
  assert.equal(isTeamSid("room-new"), true, "a room, by its own id, even when the team's hidden list leaves it out");
  assert.equal(isTeamSid("mate-1"), true, "a teammate's session");
  assert.equal(isTeamSid("code-1"), false);
  assert.deepEqual(new Set(JSON.parse(store.get("friday.crew.sids")!)), new Set(["crew-home", "room-old", "mate-1", "room-new"]), "kept for the next start");
});
