// What a crew mate is doing, in plain words for its chip (Teammates.tsx plainDoing; Arun, 2026-11-15: "design this better").
import assert from "node:assert/strict";
import test from "node:test";
import { plainDoing } from "../src/client/Teammates.js";

test("raw commands, queries and tool names become a few plain words", () => {
  assert.equal(plainDoing("Running find / -path /proc -prune -o -name x"), "Running a command");
  assert.equal(plainDoing("Running npm test -- cart"), "Running the tests");
  assert.equal(plainDoing("Searching the web for “developer tools pricing”"), "Searching the web");
  assert.equal(plainDoing("Using friday: message_agent"), "Talking to the crew");
  assert.equal(plainDoing("Reading src/cart/totals.ts"), "Reading files");
  assert.equal(plainDoing("Editing totals.ts"), "Editing files");
  assert.equal(plainDoing("Writing its answer"), "Writing its answer");
  assert.equal(plainDoing("Thinking about what to do next"), "Thinking");
  assert.ok(plainDoing("Drafting the launch post for the new pricing page and the email").length <= 33);
});
