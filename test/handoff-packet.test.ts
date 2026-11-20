import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPacket, handoffText, packetSections, shortPath, type PacketFacts } from "../src/client/ide/handoff-packet.js";
import { handBrief } from "../src/crew-carry-rules.js";
import { repoKeyOf } from "../src/repo-key.js";

const facts: PacketFacts = {
  title: "Add a Notes section",
  folder: "/work/app/",
  state: "PR #12 open",
  branch: "friday/notes",
  files: [
    { path: "/work/app/README.md", add: 6, del: 1 },
    { path: "/work/app/src/a.ts", add: 3, del: 0 },
  ],
  open: 2,
  decided: 1,
  question: "Which heading level?",
  next: "Add the Usage section",
  rules: ["Use pnpm, not npm", "No default exports"],
};

test("the packet for a teammate has the ask, state, files with counts, the open question and the rules; the hand-off itself carries branch, open items and next step", () => {
  const t = buildPacket(facts, { kind: "mate", name: "Rio" });
  assert.match(t, /^Handed from Code to Rio: “Add a Notes section” \(in app\)/);
  assert.match(t, /What was asked: Add a Notes section/);
  assert.match(t, /How it stands: PR #12 open/);
  assert.match(t, /Changed files \(2 files, \+9 -1\):\n- README\.md \(\+6 -1\)\n- src\/a\.ts \(\+3 -0\)/);
  assert.match(t, /open question, still unanswered: Which heading level\?/);
  assert.match(t, /- Use pnpm, not npm\n- No default exports/);
  assert.match(t, /project memory\) is given to you with your first run/);
  assert.ok(!/Branch:|Still open|Next step/.test(t), "said once, by the hand-off");
  // Without the hand-off's own notes (the default) they are in the sections.
  const all = packetSections(facts).join("\n");
  assert.match(all, /Branch: friday\/notes/);
  assert.match(all, /Still open: 2 things; 1 decision made/);
  assert.match(all, /Next step: Add the Usage section/);
});

test("a copy of the folder is the same repo to the project memory, so the teammate is briefed from it on its own", () => {
  assert.equal(repoKeyOf(null, "/home/me/.friday/worktrees/app-0123abcd")?.key, repoKeyOf(null, "/work/app")?.key);
  assert.equal(repoKeyOf({ github: "Acme/App" }, "/x/app-0123abcd")?.key, repoKeyOf({ github: "acme/app" }, "/work/app")?.key);
});

test("sections with nothing in them are left out", () => {
  const s = packetSections({ title: "Fix it", folder: "/x" });
  assert.deepEqual(s, ["What was asked: Fix it"]);
});

test("a long list of files is cut, with how many more", () => {
  const files = Array.from({ length: 15 }, (_, i) => ({ path: `/work/app/f${i}.ts`, add: 1, del: 0 }));
  const t = packetSections({ title: "T", folder: "/work/app", files }).join("\n");
  assert.match(t, /15 files, \+15 -0/);
  assert.match(t, /…and 3 more/);
});

test("Windows paths are shortened against the folder too", () => {
  const t = packetSections({ title: "T", folder: "C:\\work\\app", files: [{ path: "C:\\work\\app\\src\\a.ts", add: 1, del: 1 }] }).join("\n");
  assert.match(t, /- src\/a\.ts \(\+1 -1\)/);
});

test("Send to Agents still says what it always said, and leaves the rules to its own agent", () => {
  const plain = handoffText({ title: "Add a Notes section", folder: "/work/app" });
  assert.match(plain, /^Moved from Code to Agents: “Add a Notes section” \(in app\)\./);
  assert.match(plain, /Add a short hand-off to your next reply/);
  const rich = buildPacket(facts, { kind: "agents" });
  assert.match(rich, /It stands on friday\/notes, 2 files changed \(\+9 -1\)\./);
  assert.ok(!/Rules for this repo|README\.md/.test(rich), "one line of facts, not the list");
});

test("the teammate's brief starts with the packet, then who handed it on; the files are listed once", () => {
  const brief = handBrief({ title: "Notes", by: "Arun", note: "", packet: "PACKET BODY", branch: { name: "b", files: ["a.ts", "b.ts"], copied: true }, ask: [] });
  const lines = brief.split("\n\n");
  assert.equal(lines[0], "PACKET BODY");
  assert.match(lines[1]!, /handed this on/);
  assert.match(brief, /came with it\./);
  assert.ok(!/a\.ts, b\.ts/.test(brief));
  // No packet (Keep this going): as it always was.
  const plain = handBrief({ title: "Notes", by: "Arun", note: "", branch: { name: "b", files: ["a.ts"], copied: true }, ask: [] });
  assert.match(plain, /^Carry on with "Notes"\./);
  assert.match(plain, /came with it: a\.ts\./);
});

test("a path outside the folder is cut to its last parts, and a drive letter's case does not matter", () => {
  assert.equal(shortPath("/home/me/.friday/worktrees/app-1/src/deep/a.ts", "/work/app"), "src/deep/a.ts");
  assert.equal(shortPath("/work/app/src/a.ts", "/work/app"), "src/a.ts");
  assert.equal(shortPath("c:\\work\\app\\src\\a.ts", "C:\\work\\app"), "src/a.ts");
  assert.equal(shortPath("src/a.ts", "/work/app"), "src/a.ts");
});
