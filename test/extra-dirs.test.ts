// Other folders beside a lane's own, as each tool's --add-dir has them (Arun, 2026-10-19; docs/coding-tools-parity.md): handed to
// Claude Code, Codex, Copilot and Gemini as their own flags and settings, named in the standing note of every other tool, and
// kept on this computer for the folder they were chosen with, so a lane started again still has them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ADAPTERS, codexExec, withDirs, type AdapterOut, type TurnSpec } from "../src/runner/adapters.js";
import { savedDirs, startDirs } from "../src/runner/extra-dirs.js";
import { callHost } from "../src/runner/local-api.js";
import { Runner } from "../src/runner/runner.js";

let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "friday-dirs-"));
  process.env.FRIDAY_EXTRA_DIRS = path.join(dir, "extra-dirs.json");
  process.env.FRIDAY_RUNNER_STATE = path.join(dir, "runner-state.json");
});
after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));

const spec = (s: Partial<TurnSpec> = {}): TurnSpec => ({ prompt: "Look at this", resumeId: null, mode: "edits", system: "Standing note", ...s });
const dirs = ["/work/shared", "/work/docs"];

test("Claude Code, Copilot and Gemini are started with the other folders as their own flags; Cursor and the rest take none", () => {
  const claude = ADAPTERS.claude.args(spec({ dirs }));
  assert.deepEqual(claude.slice(claude.indexOf("--add-dir"), claude.indexOf("--add-dir") + 4), ["--add-dir", "/work/shared", "--add-dir", "/work/docs"]);
  assert.ok(!ADAPTERS.claude.args(spec()).includes("--add-dir"), "none given, no flag");

  const copilot = ADAPTERS.copilot.args(spec({ dirs, model: "gpt-5" }));
  assert.deepEqual(copilot.slice(-4), ["--add-dir", "/work/shared", "--add-dir", "/work/docs"]);
  assert.deepEqual(ADAPTERS.gemini.args(spec({ dirs })), ["--acp", "--include-directories", "/work/shared,/work/docs"]);
  assert.deepEqual(ADAPTERS.gemini.args(spec()), ["--acp"]);

  assert.deepEqual(ADAPTERS.cursor.args(spec({ dirs })), ADAPTERS.cursor.args(spec()), "Cursor has no such flag");
  const own = Object.values(ADAPTERS).filter((a) => a.dirs).map((a) => a.tool);
  // Muse Code takes them too, as the workspace roots of each turn (turn/start), not as a flag (test/muse-adapter.test.ts).
  assert.deepEqual(own.sort(), ["claude", "codex", "copilot", "gemini", "muse"]);
  assert.ok(codexExec.dirs);
});

test("codex exec gets --add-dir when it may write in its sandbox, and not when it only reads", () => {
  const writes = codexExec.args(spec({ dirs, mode: "full" }));
  // On Windows a Codex that may write runs without its folder sandbox (adapters.ts says why), so there is none to widen.
  if (process.platform === "win32") return void assert.ok(!writes.includes("--add-dir"));
  assert.ok(writes.join(" ").includes("--add-dir /work/shared --add-dir /work/docs"));
  assert.equal(writes.at(-1), "-", "the prompt still comes on stdin");
  const resumed = codexExec.args(spec({ dirs, mode: "full", resumeId: "r1" }));
  assert.ok(resumed.indexOf("--add-dir") < resumed.indexOf("resume"), "an exec option, before `resume`");
  assert.ok(!codexExec.args(spec({ dirs, mode: "plan" })).includes("--add-dir"), "read-only reads them anyway");
});

function codexServer(s: Partial<TurnSpec> = {}) {
  const t = spec(s);
  const sent: Record<string, any>[] = [JSON.parse(ADAPTERS.codex.stdin(t))];
  const parse = ADAPTERS.codex.parser(t, { cwd: "/work/repo", write: (l) => void sent.push(JSON.parse(l)), end: () => {} });
  const say = (o: Record<string, unknown>): AdapterOut[] => parse(JSON.stringify(o));
  say({ id: 0, result: { userAgent: "codex" } });
  say({ id: sent.at(-1)!.id, result: { thread: { id: "thr_1" } } });
  return { say, sent, last: () => sent.at(-1)!, answer: (id: number) => sent.find((m) => m.id === id && m.result)?.result };
}

test("Codex over its app-server: the other folders are writable roots, and a change in one needs nobody in Manual", { skip: process.platform === "win32" }, () => {
  const auto = codexServer({ dirs, mode: "full" });
  assert.deepEqual(auto.last().params.sandboxPolicy, { type: "workspaceWrite", networkAccess: true, writableRoots: dirs });
  assert.deepEqual(codexServer({ mode: "full" }).last().params.sandboxPolicy.writableRoots, []);

  const change = (s: ReturnType<typeof codexServer>, id: number, grantRoot: string) =>
    s.say({ id, method: "item/fileChange/requestApproval", params: { threadId: "thr_1", turnId: "t", itemId: `e${id}`, grantRoot, startedAtMs: id } });
  const manual = codexServer({ dirs, ask: true });
  assert.deepEqual(change(manual, 7, "/work/shared/lib").filter((o) => o.kind === "ask"), []);
  assert.deepEqual(manual.answer(7), { decision: "accept" });
  assert.equal(change(manual, 8, "/elsewhere").filter((o) => o.kind === "ask").length, 1, "beyond them it is still asked");
  const without = codexServer({ ask: true });
  assert.equal(change(without, 9, "/work/shared/lib").filter((o) => o.kind === "ask").length, 1, "not given, not free");
});

test("a tool with no flag hears the other folders in its standing note; one with a flag doesn't need to", () => {
  assert.equal(withDirs("Note", undefined), "Note");
  assert.equal(withDirs("", dirs), "", "no note, nothing to add to");
  assert.match(withDirs("Note", dirs), /^Note\n\n.*also read and change files in these folders:\n- \/work\/shared\n- \/work\/docs$/s);

  const turn = (tool: "cursor" | "claude" | "opencode") => {
    const r = new Runner({ server: "http://127.0.0.1:1", session: "s", invite: "i", userId: "u", name: "Ada", tool, cwd: dir, dirs, mode: "full" });
    return (r as unknown as { spec(p: string, s: string, m: string[]): TurnSpec }).spec("Go", "Standing note", []);
  };
  for (const tool of ["cursor", "opencode"] as const) {
    assert.deepEqual(turn(tool).dirs, dirs);
    assert.match(turn(tool).system, /- \/work\/docs$/);
  }
  assert.equal(turn("claude").system, "Standing note");
  assert.deepEqual(turn("claude").dirs, dirs);
  const none = new Runner({ server: "http://127.0.0.1:1", session: "s", invite: "i", userId: "u", name: "Ada", tool: "cursor", cwd: dir, mode: "full" });
  const plain = (none as unknown as { spec(p: string, s: string, m: string[]): TurnSpec }).spec("Go", "Standing note", []);
  assert.equal(plain.system, "Standing note");
  assert.equal(plain.dirs, undefined);
});

test("the folders a start gives are checked, kept for the folder, and used again by a start that doesn't say them", async () => {
  const repo = path.join(dir, "repo");
  const shared = path.join(dir, "shared");
  const docs = path.join(dir, "docs");
  for (const d of [repo, path.join(repo, "sub"), shared, path.join(shared, "inner"), docs]) await mkdir(d, { recursive: true });
  const at = (p: unknown) => path.resolve(String(p));

  assert.deepEqual(await startDirs(undefined, repo, at), [], "nothing kept yet");
  assert.deepEqual(await startDirs([path.join(shared, "inner"), shared, docs, path.join(repo, "sub"), repo, docs, "", 7], repo, at), [shared, docs], "the folder, one inside it, one inside another and repeats are left out");
  assert.deepEqual(await savedDirs(repo), [shared, docs]);
  assert.deepEqual(await startDirs(undefined, repo, at), [shared, docs], "a start again (a new mode, Reconnect) keeps them");
  assert.deepEqual(await savedDirs(path.join(dir, "other")), [], "kept for that folder alone");

  // What the picker shows when the folder is picked again.
  const described = (await callHost("describe", { path: repo, dirs: "1" }, { runners: new Map() } as never)) as { folder: { dirs?: string[] } };
  assert.deepEqual(described.folder.dirs, [shared, docs]);
  const plain = (await callHost("describe", { path: repo }, { runners: new Map() } as never)) as { folder: { dirs?: string[] } };
  assert.equal(plain.folder.dirs, undefined, "only when asked");

  await assert.rejects(startDirs([path.join(dir, "gone")], repo, at), /There's no folder at .*gone/);
  assert.deepEqual(await savedDirs(repo), [shared, docs], "a refused start changes nothing kept");

  // One that has gone since is dropped, not handed to a tool that can't open it.
  await rm(docs, { recursive: true });
  assert.deepEqual(await startDirs(undefined, repo, at), [shared]);

  assert.deepEqual(await startDirs([], repo, at), [], "an empty list is a choice too");
  assert.deepEqual(await savedDirs(repo), []);
  assert.ok(!(path.resolve(repo) in JSON.parse(await readFile(process.env.FRIDAY_EXTRA_DIRS!, "utf8"))));
});
