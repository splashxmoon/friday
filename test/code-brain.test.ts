// One brain for Code and Agents (Arun, 2026-11-20, wave 5): a Code chat's finished run teaches the same project brain, under the same
// repo key, that an Agents session on the same folder does; the lesson says which side it came from, the chat gets its quiet
// "Remembered" line, and the IDE's Memory view reads the same entries.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { BrainEntry } from "../src/brain.js";
import { remembered, repoOfFolder, surfaceOf } from "../src/code-brain.js";
import { repoKeyOf } from "../src/repo-key.js";
import { setVscodeTokenForTest } from "../src/runner/vscode.js";
import { isFirstTurn } from "../src/session/catchup.js";

const entry = (o: Partial<BrainEntry>): BrainEntry => ({ id: "a", key: "k", text: "t", kind: "fact", from: { tool: "claude", name: "x" }, at: 1, uses: 0, ...o });

test("a session is Code's when the page said it is a Code chat of its own, never a linked Agents one", () => {
  const tasks = [{ sid: "c1" }, { sid: "l1", linked: true }];
  assert.equal(surfaceOf(tasks, "c1"), "code");
  assert.equal(surfaceOf(tasks, "l1"), "agents");
  assert.equal(surfaceOf(tasks, "other"), "agents");
  assert.equal(surfaceOf([], "c1"), "agents");
});

test("remembered() names what is new or changed, and what a changed one replaced; the same words again say nothing", () => {
  const before = [entry({ id: "a", text: "Use pnpm", kind: "convention" }), entry({ id: "b", text: "Same", kind: "fact" }), entry({ id: "c", text: "Old", kind: "fact", retired: { at: 1, why: "x" } })];
  const saved = [entry({ id: "a", text: "Use pnpm 9", kind: "convention" }), entry({ id: "b", text: "Same", kind: "fact" }), entry({ id: "n", text: "New one", kind: "decision" }), entry({ id: "c", text: "Old", kind: "fact" })];
  assert.deepEqual(remembered(before, saved), [
    { entry: "a", kind: "convention", text: "Use pnpm 9", was: { text: "Use pnpm", kind: "convention" } },
    { entry: "n", kind: "decision", text: "New one" },
    // A retired lesson saved again is back in the briefings: that is news.
    { entry: "c", kind: "fact", text: "Old", was: { text: "Old", kind: "fact" } },
  ]);
});

test("the IDE finds its repo the way a session does, so Code and Agents share it", () => {
  const remote = "git@github.com:Acme/Shop.git";
  // A session's key comes from the runner's remote (github owner/name) or its url: the IDE sends the url.
  assert.deepEqual(repoOfFolder("/Users/me/code/shop", remote)?.key, repoKeyOf({ github: "Acme/Shop" }, "/Users/me/code/shop")?.key);
  assert.deepEqual(repoOfFolder("/Users/me/code/shop", "https://github.com/Acme/Shop.git")?.key, "github.com/acme/shop");
  // Remote shapes that differ only in how they are written land on the runner's key.
  for (const odd of ["https://www.github.com/Acme/Shop", "https://user:tok@github.com/Acme/Shop.git/", "ssh://git@github.com/Acme/Shop.git"]) assert.equal(repoOfFolder("/x/shop", odd)?.key, "github.com/acme/shop", odd);
  assert.equal(repoOfFolder("/x/shop", "ssh://git@github.com:22/Acme/Shop.git")?.key, repoKeyOf({ url: "ssh://git@github.com:22/Acme/Shop.git" }, "/x/shop")?.key);
  // No remote: the folder's name, a session's separate copy (name-<8 hex>) counted as the same project.
  assert.equal(repoOfFolder("/Users/me/code/shop", "")?.key, "folder:shop");
  assert.equal(repoOfFolder("C:\\Users\\me\\code\\shop-0a1b2c3d", null)?.key, "folder:shop");
});

// A coding tool that answers the lesson-reading question with a decision.
const FAKE = `#!/usr/bin/env node
import path from "node:path";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (path.basename(process.cwd()) !== "friday-ask") process.exit(1);
  const answer = JSON.stringify([{ key: "tests-need-redis", kind: "convention", text: "Run the tests with npm test; they need Redis on port 6379 first." }]);
  out({ type: "system", subtype: "init", session_id: "ask", cwd: process.cwd() });
  out({ type: "assistant", message: { content: [{ type: "text", text: answer }] }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: "ask" });
});
`;

test("a Code chat's run teaches the same brain as an Agents session on that folder, labelled, with its Remembered line", async (t) => {
  process.env.FRIDAY_LOCAL_RUNNER = "0";
  process.env.FRIDAY_EDITION = "local";
  const home = await mkdtemp(path.join(tmpdir(), "friday-code-brain-"));
  const fake = path.join(home, "fake-claude.mjs");
  await writeFile(fake, FAKE);
  await chmod(fake, 0o755);
  const had = { bin: process.env.FRIDAY_CLAUDE_BIN, ed: process.env.FRIDAY_EDITION };
  process.env.FRIDAY_CLAUDE_BIN = fake;
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, decisionLog: true, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
  t.after(async () => {
    await app.close();
    await kv.close();
    await rm(home, { recursive: true, force: true });
    delete process.env.FRIDAY_EDITION;
    had.bin === undefined ? delete process.env.FRIDAY_CLAUDE_BIN : (process.env.FRIDAY_CLAUDE_BIN = had.bin);
  });
  const call = async <T,>(p: string, method = "GET", json?: unknown): Promise<T> => {
    const r = await fetch(`${app.url}${p}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1" }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
    const text = await r.text();
    assert.ok(r.ok, `${method} ${p}: ${r.status} ${text}`);
    return JSON.parse(text) as T;
  };
  const until = async (what: string, p: () => Promise<boolean>) => {
    for (let i = 0; i < 400; i++) if (await p()) return;
    else await new Promise((r) => setTimeout(r, 25));
    assert.fail(`waited for ${what}`);
  };
  const me = { id: "local", name: "Me", kind: "human" as const };
  const claude = { id: "agent", name: "Claude Code", kind: "agent" as const };
  const folder = path.join(home, "shop");
  const start = async (title: string) => {
    const { sessionId } = await call<{ sessionId: string }>("/api/sessions", "POST", { title });
    await app.store.append(sessionId, claude, { type: "engine.attached", engine: { tool: "claude", hostId: "local", hostName: "Me", cwd: folder, mode: "full" } } as never);
    return sessionId;
  };
  const turn = async (sid: string, text: string) => {
    await app.store.append(sid, me, { type: "instruction", text, interrupt: false });
    await app.store.append(sid, claude, { type: "run.started" } as never);
    await app.store.append(sid, claude, { type: "agent.message", text: "Done: the suite runs.", toolCalls: [1, 2, 3, 4].map((i) => ({ id: `t${i}`, name: "Bash", arguments: "{}" })) } as never);
    await app.store.append(sid, claude, { type: "run.ended", outcome: "done" });
  };
  type Entry = BrainEntry;
  const repo = encodeURIComponent("folder:shop");
  const entries = async () => (await call<{ entries: Entry[] }>(`/api/brain/entries?repo=${repo}`)).entries;

  // The page says which session is a Code chat (it keeps them in its own storage).
  const code = await start("Get the tests running");
  await call("/api/vscode/tasks", "POST", { tasks: [{ sid: code, title: "Get the tests running", folder, tool: "claude", at: Date.now() }] });
  await turn(code, "Get the test suite running here");
  await until("the Code chat's lesson", async () => (await entries()).length === 1);
  const [learned] = await entries();
  assert.equal(learned!.kind, "convention");
  assert.equal(learned!.from.surface, "code");
  assert.equal(learned!.from.sid, code);
  assert.equal(learned!.from.title, "Get the tests running");

  // It says so in the chat, with the lesson's id, so Undo can take it out.
  await until("the Remembered line", async () => (await app.store.events(code)).some((e) => e.body.type === "brain.remembered"));
  const said = (await app.store.events(code)).find((e) => e.body.type === "brain.remembered")!.body as { entry: string; text: string; repo: string; was?: unknown };
  assert.deepEqual([said.entry, said.repo, said.text, said.was], [learned!.id, "folder:shop", learned!.text, undefined]);

  // An Agents session on the same folder lands on the same repo: one repo listed, not two, and the brief it would start with has the lesson.
  const agents = await start("Orders endpoint");
  const { repos } = await call<{ repos: { key: string; count: number }[] }>("/api/brain");
  assert.deepEqual(repos.map((r) => [r.key, r.count]), [["folder:shop", 1]]);
  const brief = await call<{ ids: string[] }>(`/api/brain/brief?repo=${repo}&task=${encodeURIComponent("run the tests")}`);
  assert.deepEqual(brief.ids, [learned!.id]);

  // Agents' own run on that folder adds to the same list, labelled as Agents'.
  await app.store.append(agents, me, { type: "instruction", text: "x", interrupt: false });
  const hand = await call<{ entry: Entry }>(`/api/brain/entries?repo=${repo}`, "POST", { text: "Never run the migrations against the shared database.", kind: "decision" });
  assert.equal(hand.entry.from.tool, "person");
  assert.equal((await entries()).length, 2);

  // Undo, as the chat's line does it: the lesson is gone from the one brain.
  await call(`/api/brain/entry?repo=${repo}&id=${learned!.id}`, "DELETE");
  assert.deepEqual((await entries()).map((e) => e.id), [hand.entry.id]);

  // The IDE's own door (/api/vscode/memory) is its token's alone, and lands in the same brain.
  setVscodeTokenForTest("tok-ide");
  t.after(() => setVscodeTokenForTest(null));
  const door = (method: string, q: string, token: string | null, json?: unknown) =>
    fetch(`${app.url}/api/vscode/memory${q}`, { method, headers: { "Content-Type": "application/json", "x-friday-local": "1", ...(token ? { "x-friday-vscode": token } : {}) }, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
  for (const token of [null, "wrong"]) {
    assert.equal((await door("GET", `?folder=${encodeURIComponent(folder)}`, token)).status, 401, `GET with ${token}`);
    assert.equal((await door("POST", "", token, { folder, op: "add", text: "Sneaky note here, ten chars" })).status, 401, `POST with ${token}`);
  }
  assert.equal((await entries()).length, 1, "a refused call changed nothing");
  const viaIde = async (op: string, extra: Record<string, unknown>, remote = "") => {
    const r = await door("POST", "", "tok-ide", { folder, remote, op, ...extra });
    assert.equal(r.status, 200);
    return (await r.json()) as { enabled: boolean; repo: { key: string }; entries: Entry[] };
  };
  const seen = await (await door("GET", `?folder=${encodeURIComponent(folder)}&remote=`, "tok-ide")).json() as { repo: { key: string }; entries: Entry[] };
  assert.equal(seen.repo.key, "folder:shop");
  assert.deepEqual(seen.entries.map((e) => e.id), [hand.entry.id], "the folder's repo is the one the page reads");
  const added = await viaIde("add", { text: "Start the dev server with npm run dev on port 5173", kind: "convention" });
  const mine = added.entries.find((e) => /npm run dev/.test(e.text))!;
  assert.equal(mine.from.surface, "code");
  assert.deepEqual((await entries()).map((e) => e.id).sort(), [hand.entry.id, mine.id].sort(), "added through the IDE, listed by the page's route");
  await viaIde("edit", { id: mine.id, text: "Start the dev server with npm run dev on port 5174" });
  assert.match((await entries()).find((e) => e.id === mine.id)!.text, /5174/);
  await viaIde("forget", { id: mine.id });
  assert.deepEqual((await entries()).map((e) => e.id), [hand.entry.id]);
  // The same GitHub repo in a different spelling is the same brain a session on it would use.
  const gh = await viaIde("add", { text: "Deploys go out from the release branch only.", kind: "decision" }, "https://www.github.com/Acme/Shop.git");
  assert.equal(gh.repo.key, "github.com/acme/shop");
  const onRepo = (await call<{ entries: Entry[] }>(`/api/brain/entries?repo=${encodeURIComponent("github.com/acme/shop")}`)).entries;
  assert.equal(onRepo.length, 1);

  // A lane's first turn is its first even though the store's live array already holds the turn's own delivery (the local store hands
  // that array out), so the lane is briefed from the brain then and not on its second turn.
  const lane = await start("Briefing check");
  // Read after the append either way: this store hands out its live array, the open-source edition's a copy; both then hold it.
  await app.store.append(lane, claude, { type: "instructions.delivered", seqs: [], turn: "t1" } as never);
  let evs = await app.store.events(lane);
  await until("the delivery in the log", async () => ((evs = await app.store.events(lane)), evs.some((e) => e.body.type === "instructions.delivered")));
  assert.equal(isFirstTurn(evs, "main", "local", "t1"), true, "the first turn carries the briefing");
  await app.store.append(lane, claude, { type: "instructions.delivered", seqs: [], turn: "t2" } as never);
  let later = await app.store.events(lane);
  await until("the second delivery", async () => ((later = await app.store.events(lane)), later.filter((e) => e.body.type === "instructions.delivered").length === 2));
  assert.equal(isFirstTurn(later, "main", "local", "t2"), false, "the second turn does not");
});
