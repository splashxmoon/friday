import assert from "node:assert/strict";
import test from "node:test";
import { iosFolders, MAX_IOS_FOLDERS } from "../src/client/ios-folders.js";
import type { SessionEvent } from "../src/types.js";

/** Arun, 2026-10-20: the agents built an iOS app in ~/Desktop/edge-app while the session's folder was another repo. */
const ran = (seq: number, args: Record<string, unknown>, name = "shell"): SessionEvent =>
  ({ seq, ts: 0, actor: { id: "e", name: "Claude Code", kind: "agent" }, body: { type: "agent.message", text: "", toolCalls: [{ id: `c${seq}`, name, arguments: JSON.stringify(args) }] } }) as SessionEvent;

test("the iOS side looks where the agents are building when the session's folder has no Xcode project", () => {
  const cwd = "/Users/arundass/.friday/worktrees/edge-b37001cc";
  const events = [
    ran(1, { command: "cd /Users/arundass/Desktop/edge-app/Packages/EdgeConsumerUI && swift test 2>&1 | grep -v warning" }),
    ran(2, { path: "/Users/arundass/Desktop/edge-app/Sources/App/InsightsView.swift", old_string: "a", new_string: "b" }, "edit"),
    ran(3, { command: `ls ${cwd}/client` }),
  ];
  const got = iosFolders(events, cwd);
  assert.equal(got[0], "/Users/arundass/Desktop/edge-app", "the app's own folder first: every path the agents used is in it");
  assert.ok(!got.includes("/Users/arundass/Desktop") && !got.includes("/Users/arundass"), "never the Desktop or the home folder");
  assert.ok(!got.includes(cwd), "not the session's own folder again");
  assert.ok(!got.some((d) => d.endsWith(".swift")), "a file is not a folder to look in");
  assert.ok(got.length <= MAX_IOS_FOLDERS);
});

test("a project named outright, and the folder a coding tool runs in, come first", () => {
  const events = [ran(1, { command: "cd /Users/a/work/other && ls" }), ran(2, { command: "cd /Users/a/work/other && ls" }), ran(3, { command: "xcodebuild -project /Users/a/work/phone/Phone.xcodeproj -list" })];
  assert.equal(iosFolders(events, "/Users/a/work/web")[0], "/Users/a/work/phone");
  assert.equal(iosFolders([ran(1, { command: "cd /Users/a/work/other && ls" })], "/Users/a/work/web", ["/Users/a/work/mobile"])[0], "/Users/a/work/mobile");
  assert.deepEqual(iosFolders([], "/Users/a/work/web"), [], "nowhere else named: nowhere else looked");
});

/** Arun, 2026-10-25: Boss Man built and opened the app from a copy in ~/.friday/worktrees, and the iOS side found no project. */
test("the copy the app is built in comes first, never the folder all the copies are in, and an agent can name it outright", () => {
  const cwd = "/Users/arundass/.friday/worktrees/edge-b37001cc";
  const server = (n: number) => ran(n, { command: `cd /Users/arundass/.friday/worktrees/edge-b37001cc-${n % 3} && npm test` });
  const events = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(server),
    ran(10, { command: "cd /Users/arundass/.friday/worktrees/edge-app-data && xcodebuild -scheme EdgeDefenseAI -destination 'platform=iOS Simulator,name=iPhone 17' build" }),
  ];
  const got = iosFolders(events, cwd, ["/Users/arundass/.friday/worktrees/edge-b37001cc-d41d587d"]);
  assert.equal(got[0], "/Users/arundass/.friday/worktrees/edge-app-data", "where it was built, though the server's copies were named more, one of them a tool's own");
  assert.ok(!got.includes("/Users/arundass/.friday/worktrees") && !got.includes("/Users/arundass/.friday"), "never the folders holding the copies");
  const said = [...events, { seq: 11, ts: 0, actor: { id: "e", name: "Boss Man", kind: "agent" }, body: { type: "preview.asked", ios: true, folder: "/Users/arundass/.friday/worktrees/edge-app-home" } } as SessionEvent];
  assert.equal(iosFolders(said, cwd)[0], "/Users/arundass/.friday/worktrees/edge-app-home", "where the agent said the app is, first of all");
});
