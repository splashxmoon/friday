import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { listCliSessions } from "../src/runner/imports.js";

/**
 * Importing a session only makes sense if the folder it ran in is still there,
 * so these fixtures put real folders behind the transcripts.
 */

let home = "";
let projA = "";
let projB = "";

const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";

before(async () => {
  home = await mkdtemp(path.join(tmpdir(), "friday-imports-"));
  projA = path.join(home, "code", "api");
  projB = path.join(home, "code", "site");
  await mkdir(projA, { recursive: true });
  await mkdir(projB, { recursive: true });

  // Claude Code: one folder per project, one .jsonl per conversation.
  const claude = path.join(home, ".claude", "projects", "-code-api");
  await mkdir(claude, { recursive: true });
  await writeFile(
    path.join(claude, "11111111-2222-3333-4444-555555555555.jsonl"),
    jsonl(
      { type: "queue-operation", operation: "enqueue" },
      { type: "user", cwd: projA, sessionId: "11111111-2222-3333-4444-555555555555", gitBranch: "main", timestamp: "2026-09-10T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Fix the login redirect loop" }] } },
      { type: "assistant", cwd: projA, sessionId: "11111111-2222-3333-4444-555555555555", timestamp: "2026-09-10T10:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Looking at the session cookie." }] } },
      // `customTitle`, as Claude Code actually writes it. This fixture said
      // `title`, so it agreed with the bug it was meant to catch.
      { type: "custom-title", customTitle: "Login redirect loop" },
    ),
  );
  // A session whose folder is gone can't be resumed, so it must not be offered.
  const stale = path.join(home, ".claude", "projects", "-gone");
  await mkdir(stale, { recursive: true });
  await writeFile(
    path.join(stale, "99999999-2222-3333-4444-555555555555.jsonl"),
    jsonl({ type: "user", cwd: path.join(home, "deleted-project"), sessionId: "99999999-2222-3333-4444-555555555555", message: { role: "user", content: "hello" } }),
  );

  // Codex: rollout files under sessions/<year>/<month>/<day>/.
  const codex = path.join(home, ".codex", "sessions", "2026", "09", "11");
  await mkdir(codex, { recursive: true });
  await writeFile(
    path.join(codex, "rollout-2026-09-11T09-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
    jsonl(
      { timestamp: "2026-09-11T09:00:00.000Z", type: "session_meta", payload: { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cwd: projB, cli_version: "0.5.0" } },
      { timestamp: "2026-09-11T09:00:05.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a health check endpoint" }] } },
      { timestamp: "2026-09-11T09:00:30.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added /healthz." }] } },
    ),
  );

  // Cursor: best-effort, since its store has moved between versions.
  const cursor = path.join(home, ".cursor", "chats", "abc123");
  await mkdir(cursor, { recursive: true });
  await writeFile(
    path.join(cursor, "chat.jsonl"),
    jsonl({ chatId: "chat-abc123", cwd: projA, title: "Tidy the CSS", updatedAt: Date.parse("2026-09-09T12:00:00.000Z") }, { role: "user", content: "tidy the css" }),
  );

});
after(() => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/**
 * A home of its own, so these fixtures don't change what the lists above say.
 */
async function withTitles(): Promise<{ home: string; sessions: Awaited<ReturnType<typeof listCliSessions>>["sessions"] }> {
  const h = await mkdtemp(path.join(tmpdir(), "friday-titles-"));
  const cwd = path.join(h, "code", "site");
  await mkdir(cwd, { recursive: true });
  const dir = path.join(h, ".claude", "projects", "-code-site");
  await mkdir(dir, { recursive: true });
  const say = (text: string, over: Record<string, unknown> = {}) => ({
    type: "user",
    cwd,
    timestamp: "2026-09-12T10:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
    ...over,
  });
  await writeFile(
    path.join(dir, "aaaa1111-2222-3333-4444-555555555555.jsonl"),
    jsonl(say("Fix the login redirect loop"), { type: "ai-title", aiTitle: "Health check endpoint" }, { type: "custom-title", customTitle: "Login redirect loop" }),
  );
  await writeFile(
    path.join(dir, "bbbb1111-2222-3333-4444-555555555555.jsonl"),
    jsonl(say("You are operating in a git worktree. Worktree path: /tmp/wt-1234"), say("Add a health check endpoint"), { type: "ai-title", aiTitle: "Health check endpoint" }),
  );
  await writeFile(
    path.join(dir, "cccc1111-2222-3333-4444-555555555555.jsonl"),
    jsonl(
      say("This session is being continued from a previous conversation that ran out of context."),
      say("Reading the config", { isMeta: true }),
      say(`Here is a document I pasted. ${"lorem ipsum ".repeat(40)}`),
    ),
  );
  const { sessions } = await listCliSessions({ home: h, tools: ["claude"] });
  return { home: h, sessions };
}

/**
 * What a session is called.
 *
 * A transcript's first user message is very often not what the session was
 * about: a worktree preamble, the summary a compacted session resumes from,
 * or a pasted document. Every one of these was showing up as a title, and
 * several sessions in a row read "You are operating in a git worktree…",
 * which tells you nothing about which of them you want.
 */
test("a session is called what somebody named it, not what it happened to open with", async (t) => {
  const { home: h, sessions } = await withTitles();
  t.after(() => rm(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const byId = (p: string) => sessions.find((s) => s.id.startsWith(p))!;

  assert.equal(byId("aaaa").title, "Login redirect loop", "the title somebody set wins over everything");
  assert.equal(byId("bbbb").title, "Health check endpoint", "then the one Claude wrote, over a worktree preamble");
  // Nothing named it, so it falls to the first thing actually typed — past
  // the compaction preamble and past the message the CLI inserted.
  assert.ok(byId("cccc").title.startsWith("Here is a document I pasted."));
});

test("a title is short enough to read in a list", async (t) => {
  const { home: h, sessions } = await withTitles();
  t.after(() => rm(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const long = sessions.find((s) => s.id.startsWith("cccc"))!;
  assert.ok(long.title.length <= 80, `got ${long.title.length} characters`);
  assert.ok(long.title.endsWith("…"), "and says it was cut");
});

test("past sessions from each CLI are listed with what they were about, newest first", async () => {
  // Asked for by name: Friday only offers Claude Code today, but the readers
  // for the other two are still here and still have to work.
  const { sessions } = await listCliSessions({ home, tools: ["claude", "codex", "cursor"] });
  assert.deepEqual(
    sessions.map((s) => [s.tool, s.title]),
    [
      ["codex", "Add a health check endpoint"],
      ["claude", "Login redirect loop"],
      ["cursor", "Tidy the CSS"],
    ],
  );

  const claude = sessions.find((s) => s.tool === "claude")!;
  assert.equal(claude.id, "11111111-2222-3333-4444-555555555555", "the id is what the CLI resumes by");
  assert.equal(claude.cwd, projA, "resuming has to happen in the folder it ran in");
  assert.equal(claude.branch, "main");
  assert.equal(claude.messages, 2);

  const codex = sessions.find((s) => s.tool === "codex")!;
  assert.equal(codex.id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(codex.cwd, projB);
});

test("a session whose folder is gone isn't offered, since it couldn't be resumed", async () => {
  const { sessions } = await listCliSessions({ home, tools: ["claude", "codex", "cursor"] });
  assert.ok(!sessions.some((s) => s.id.startsWith("99999999")));
});

test("a session that began in a scratch folder is listed where it actually ran", async () => {
  // Claude Code started from the Claude app records a temporary workspace in
  // its first record and the real folder from then on. Taking the first one
  // pointed the session at a folder that no longer exists, and sessions whose
  // folder is gone are dropped — so the newest sessions simply vanished.
  const own = await mkdtemp(path.join(tmpdir(), "friday-scratch-"));
  const real = path.join(own, "code", "site");
  await mkdir(real, { recursive: true });
  const dir = path.join(own, ".claude", "projects", "-code-site");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "77777777-2222-3333-4444-555555555555.jsonl"),
    jsonl(
      { type: "user", cwd: path.join(own, "scratch-workspaces", "gone"), sessionId: "77777777-2222-3333-4444-555555555555", timestamp: "2026-09-12T10:00:00.000Z", message: { role: "user", content: "Start" } },
      { type: "assistant", cwd: real, sessionId: "77777777-2222-3333-4444-555555555555", timestamp: "2026-09-12T10:01:00.000Z", message: { role: "assistant", content: "On it." } },
    ),
  );
  const { sessions } = await listCliSessions({ home: own, tools: ["claude"] });
  assert.equal(sessions[0]?.cwd, real);
  await rm(own, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("one tool can be asked for on its own, and an empty store explains itself", async () => {
  const { sessions, notes } = await listCliSessions({ home, tools: ["claude"] });
  assert.deepEqual(sessions.map((s) => s.tool), ["claude"]);
  assert.equal(notes.codex, undefined);

  const empty = await mkdtemp(path.join(tmpdir(), "friday-empty-"));
  try {
    const r = await listCliSessions({ home: empty });
    assert.deepEqual(r.sessions, []);
    assert.match(r.notes.claude!, /No Claude Code sessions/);
  } finally {
    await rm(empty, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
