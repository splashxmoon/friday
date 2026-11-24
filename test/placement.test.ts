import assert from "node:assert/strict";
import test from "node:test";
import { bestComputer, rankComputers, repoKey, type MachineFacts, type PlaceCandidate } from "../src/placement.js";
import { limitSummary, readPower } from "../src/runner/machine-facts.js";

const facts = (o: Partial<MachineFacts> = {}): MachineFacts => ({
  v: 1, platform: "darwin", arch: "arm64", cpus: 10, memGb: 32, freeDiskGb: 200, power: "ac", batteryPercent: null, load: 0.1, agents: 0,
  limits: {}, repos: [], xcode: false, docker: false, localModels: [], at: 0, ...o,
});
const claude = [{ tool: "claude", name: "Claude Code", loggedIn: true }];
const pc = (id: string, f: MachineFacts | null, o: Partial<PlaceCandidate> = {}): PlaceCandidate => ({ id, name: id || "This computer", connected: true, tools: claude, facts: f, ...o });

test("a laptop on battery loses to a desktop on power", () => {
  const best = bestComputer([pc("", facts({ power: "battery", batteryPercent: 60 })), pc("desk", facts())], { tool: "claude" });
  assert.equal(best?.id, "desk");
  assert.ok(best!.why.includes("on power"));
});

test("the tool's limit decides, and a spent one can't take the run", () => {
  const list = [pc("", facts({ limits: { claude: { usedPercent: 99, resetsAt: null, window: "5-hour" } } })), pc("mini", facts({ limits: { claude: { usedPercent: 12, resetsAt: null, window: "5-hour" } } }))];
  const r = rankComputers(list, { tool: "claude" });
  assert.equal(r[0]!.id, "mini");
  assert.ok(r[0]!.why.includes("Claude Code 12% used"));
  assert.equal(r[1]!.ok, false);
  assert.match(r[1]!.not!, /out of its 5-hour limit/);
});

test("a tool that isn't signed in there, or an off computer, is never picked", () => {
  const r = rankComputers([pc("a", facts(), { tools: [{ tool: "codex", name: "Codex", loggedIn: true }] }), pc("b", facts(), { connected: false })], { tool: "claude" });
  assert.ok(r.every((x) => !x.ok));
  assert.equal(bestComputer([pc("b", facts(), { connected: false })]), null);
});

test("the repo already cloned there counts, and says so first", () => {
  const best = bestComputer([pc("", facts()), pc("box", facts({ repos: [{ name: "acme/storefront", path: "/x" }] }))], { tool: "claude", repo: "acme/storefront" });
  assert.equal(best?.id, "box");
  assert.equal(best!.why[0], "storefront is here");
});

test("iOS goes only to a Mac with Xcode", () => {
  const r = rankComputers([pc("linux", facts({ platform: "linux" })), pc("mac", facts({ xcode: true }))], { ios: true });
  assert.equal(r[0]!.id, "mac");
  assert.equal(r[1]!.ok, false);
});

test("an older Friday with no facts can still take work", () => {
  assert.equal(bestComputer([pc("old", null)])?.id, "old");
});

test("repoKey reads owner/name from a remote, else the folder", () => {
  assert.equal(repoKey("git@github.com:Acme/Storefront.git", "x"), "acme/storefront");
  assert.equal(repoKey("https://github.com/acme/api/", "x"), "acme/api");
  assert.equal(repoKey(undefined, "Notes"), "notes");
});

test("limitSummary keeps each tool's fullest window", () => {
  const s = limitSummary({
    claudeWindows: [{ utilization: 0.2, resetsAt: 1, kind: "five_hour" }, { utilization: 0.55, resetsAt: 2, kind: "seven_day" }],
    codexWindows: [{ usedPercent: 31, resetsAt: 3, windowMinutes: 10080 }],
    tools: { cursor: { windows: [{ usedPercent: 80, windowMinutes: null }] } },
  });
  assert.deepEqual(s.claude, { usedPercent: 55, resetsAt: 2, window: "weekly" });
  assert.equal(s.codex?.window, "weekly");
  assert.equal(s.cursor?.usedPercent, 80);
});

test("readPower answers on any system without throwing", async () => {
  const p = await readPower();
  assert.ok(["ac", "battery", "unknown"].includes(p.power));
});
