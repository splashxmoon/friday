import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SYSTEM_NOTE } from "../src/engine/hub.js";
import { claude, codexExec as codex, cursor, PROMPT_MARK, tooLongForArgv } from "../src/runner/adapters.js";
import { listCliSessions, readCliTranscript } from "../src/runner/imports.js";

/**
 * Continuing a conversation somebody had in their own coding tool has to be true end to end: the list shows the conversations
 * they had, under what they asked, with as many messages as there really were, and continuing one brings that conversation, in
 * the folder and on the branch it ended in. Each test here is a way that was not so, built the way the tool really writes it.
 */

const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
let home = "";
const homes: string[] = [];
after(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
/** A home of its own per test, so one fixture never changes what another lists. */
const own = async () => {
  home = await mkdtemp(path.join(tmpdir(), "friday-continue-"));
  homes.push(home);
  return home;
};
const dir = async (...p: string[]) => {
  const d = path.join(home, ...p);
  await mkdir(d, { recursive: true });
  return d;
};

const said = (cwd: string, sessionId: string, type: "user" | "assistant", content: unknown, over: Record<string, unknown> = {}) => ({
  type,
  cwd,
  sessionId,
  timestamp: "2026-10-01T10:00:00.000Z",
  message: { role: type, content },
  ...over,
});

test("Cursor: today's chats (a folder per chat, keyed by the md5 of where it ran) are listed and read back", async () => {
  const h = await own();
  const cwd = await dir("Desktop", "friday site");
  const id = "67bd93de-0962-496d-8a2f-14a73cdc1c48";
  const chat = await dir(".cursor", "chats", createHash("md5").update(cwd).digest("hex"), id);
  await writeFile(path.join(chat, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: 1, hasConversation: true, updatedAtMs: Date.parse("2026-10-01T04:13:00Z"), cwd }));
  await writeFile(path.join(chat, "store.db"), "");
  // Opened and never used: nothing to continue.
  const empty = await dir(".cursor", "chats", "0000", "aaaaaaaa-0000-0000-0000-000000000000");
  await writeFile(path.join(empty, "meta.json"), JSON.stringify({ schemaVersion: 1, hasConversation: false, updatedAtMs: 2, cwd }));
  const slug = cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const transcripts = await dir(".cursor", "projects", slug, "agent-transcripts", id);
  const ask = (text: string) => ({ role: "user", message: { content: [{ type: "text", text: `<timestamp>Thursday, Oct 1, 2026, 12:10 AM (UTC-4)</timestamp>\n<user_query>\n${text}\n</user_query>` }] } });
  await writeFile(
    path.join(transcripts, `${id}.jsonl`),
    jsonl(
      // Cursor has no flag for standing instructions, so Friday's note led the first message it was sent.
      ask(`${SYSTEM_NOTE}\n\nArun Dass: make the solutions pages match pricing`),
      { role: "assistant", message: { content: [{ type: "text", text: "Looking at how routing works." }, { type: "tool_use", name: "Read", input: {} }] } },
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: {} }] } },
      ask("Arun Dass: and the menu too"),
      { role: "assistant", message: { content: [{ type: "text", text: "Both pages and the menu now match." }] } },
      { type: "turn_ended", status: "success" },
    ),
  );
  // A chat from the Cursor editor: its CLI can't resume it, so it is not offered.
  const ide = await dir(".cursor", "projects", "c-other", "agent-transcripts", "ide-chat");
  await writeFile(path.join(ide, "ide-chat.jsonl"), jsonl(ask("an editor chat"), { role: "assistant", message: { content: "ok" } }));

  const { sessions } = await listCliSessions({ home: h, tools: ["cursor"] });
  assert.deepEqual(sessions.map((s) => s.id), [id], "the chat, by the id `--resume` takes, and nothing else");
  assert.equal(sessions[0]!.cwd, cwd, "the folder exactly as Cursor wrote it: it finds the chat by its md5");
  assert.equal(sessions[0]!.title, "Arun Dass: make the solutions pages match pricing", "what was asked, not the time or Friday's note");
  assert.equal(sessions[0]!.messages, 4, "what was said, not the tool calls");

  const t = await readCliTranscript({ tool: "cursor", id, home: h });
  assert.equal(t.found, true);
  assert.deepEqual(
    t.turns.map((x) => x.text),
    ["Arun Dass: make the solutions pages match pricing", "Looking at how routing works. [used Read]", "Arun Dass: and the menu too", "Both pages and the menu now match."],
  );
  assert.equal(t.total, 4);

  // The readable copy is written after meta.json: listed again, the chat has what was added, though meta.json hasn't changed.
  await appendFile(path.join(transcripts, `${id}.jsonl`), jsonl(ask("Arun Dass: and the footer"), { role: "assistant", message: { content: [{ type: "text", text: "Done." }] } }));
  const again = await listCliSessions({ home: h, tools: ["cursor"] });
  assert.equal(again.sessions[0]!.messages, 6);
});

test("Cursor: with no readable copy, the chat comes from its own store where this Node can read it, and is left out where it can't", async (t) => {
  const h = await own();
  const cwd = await dir("site");
  const id = "bbbbbbbb-0000-0000-0000-000000000000";
  const chat = await dir(".cursor", "chats", createHash("md5").update(cwd).digest("hex"), id);
  await writeFile(path.join(chat, "meta.json"), JSON.stringify({ hasConversation: true, updatedAtMs: 5, cwd }));
  const name = "node:sqlite";
  const sq = (await import(name).catch(() => null)) as { DatabaseSync: new (p: string) => any } | null;
  if (sq) {
    const db = new sq.DatabaseSync(path.join(chat, "store.db"));
    db.exec("create table blobs (id text primary key, data blob); create table meta (key text primary key, value text);");
    const put = db.prepare("insert into blobs (id, data) values (?, ?)");
    const blobs = [
      { role: "system", content: "You are an AI coding assistant." },
      { role: "user", content: "<user_info>\nOS Version: win32\n</user_info>" },
      { role: "user", content: [{ type: "text", text: "<timestamp>x</timestamp>\n<user_query>\nFix the footer\n</user_query>" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "hm" }, { type: "text", text: "Fixed the footer." }, { type: "tool-call", toolName: "Edit" }] },
      { role: "tool", content: [{ type: "tool-result" }] },
    ];
    blobs.forEach((b, i) => put.run(String(i), Buffer.from(JSON.stringify(b))));
    put.run("tree", Buffer.from([0, 1, 2, 3]));
    db.close();
  } else await writeFile(path.join(chat, "store.db"), "");
  const { sessions } = await listCliSessions({ home: h, tools: ["cursor"] });
  if (!sq) {
    assert.deepEqual(sessions, [], "an older Node can't open it, and the listing goes on without it");
    return t.diagnostic("node:sqlite isn't in this Node, so only the fallback was checked");
  }
  assert.equal(sessions[0]?.id, id);
  assert.equal(sessions[0]?.title, "Fix the footer", "the machine description Cursor put first is not what was asked");
  const r = await readCliTranscript({ tool: "cursor", id, home: h });
  assert.deepEqual(r.turns.map((x) => x.role), ["user", "assistant"]);
  assert.match(r.turns[1]!.text, /Fixed the footer\. \[used Edit\]/);
});

test("Claude Code: a helper agent's transcript is never taken for the session, however recently it was written", async () => {
  const h = await own();
  const cwd = await dir("api");
  const id = "84bdb670-1111-2222-3333-444444444444";
  const proj = await dir(".claude", "projects", "-api");
  await writeFile(
    path.join(proj, `${id}.jsonl`),
    jsonl(said(cwd, id, "user", "Why does checkout hang on a slow card?"), said(cwd, id, "assistant", [{ type: "text", text: "The request has no timeout." }])),
  );
  // Claude Code files each helper agent's conversation under the session, with the session's id in every record.
  const sub = await dir(".claude", "projects", "-api", id, "subagents");
  const helper = path.join(sub, "agent-a1.jsonl");
  await writeFile(helper, jsonl(said(cwd, id, "user", "Scan every file for fetch calls", { isSidechain: true, timestamp: "2026-10-07T10:00:00Z" }), said(cwd, id, "assistant", "Found 12.", { isSidechain: true, timestamp: "2026-10-07T10:00:01Z" })));
  // Older versions kept them beside the session.
  await writeFile(path.join(proj, "agent-b2.jsonl"), jsonl(said(cwd, id, "user", "Old helper", { isSidechain: true })));
  await utimes(helper, new Date(), new Date(Date.now() + 60_000));

  const { sessions } = await listCliSessions({ home: h, tools: ["claude"] });
  assert.deepEqual(
    sessions.map((s) => [s.id, s.title, s.messages]),
    [[id, "Why does checkout hang on a slow card?", 2]],
  );
  const t = await readCliTranscript({ tool: "claude", id, home: h });
  assert.deepEqual(t.turns.map((x) => x.text), ["Why does checkout hang on a slow card?", "The request has no timeout."]);
});

test("Claude Code: the count is of messages, not of records, so it is the count that comes along", async () => {
  const h = await own();
  const cwd = await dir("api");
  const id = "08f144ea-1111-2222-3333-444444444444";
  const proj = await dir(".claude", "projects", "-api");
  await writeFile(
    path.join(proj, `${id}.jsonl`),
    jsonl(
      said(cwd, id, "user", "Caveat: the messages below were generated by the user while running local commands.", { isMeta: true }),
      said(cwd, id, "user", "Make the retry helper configurable"),
      said(cwd, id, "assistant", [{ type: "thinking", thinking: "Let me look" }]),
      said(cwd, id, "assistant", [{ type: "tool_use", id: "t1", name: "Read", input: {} }]),
      said(cwd, id, "user", [{ type: "tool_result", tool_use_id: "t1", content: "file contents" }]),
      said(cwd, id, "assistant", [{ type: "tool_use", id: "t2", name: "Edit", input: {} }]),
      said(cwd, id, "user", [{ type: "tool_result", tool_use_id: "t2", content: "ok" }]),
      said(cwd, id, "assistant", [{ type: "text", text: "Done: it reads RETRIES from the environment." }]),
    ),
  );
  const { sessions } = await listCliSessions({ home: h, tools: ["claude"] });
  assert.equal(sessions[0]!.messages, 2);
  const t = await readCliTranscript({ tool: "claude", id, home: h });
  assert.equal(t.turns.length, 2);
  assert.equal(t.total, 2, "nobody is told there were messages that did not come along");
  assert.equal(t.partial, undefined);
});

test("Codex: titled and counted by what was asked, not by what Codex or Friday put in front of it", async () => {
  const h = await own();
  const cwd = await dir("shop");
  const d = await dir(".codex", "sessions", "2026", "10", "02");
  const msg = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] } });
  const rollout = async (id: string, ...recs: unknown[]) => writeFile(path.join(d, `rollout-2026-10-02T09-00-00-${id}.jsonl`), jsonl({ type: "session_meta", payload: { id, cwd } }, ...recs));
  const env = msg("user", `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>powershell</shell>\n</environment_context>`);
  await rollout(
    "01a11a23-0000-0000-0000-000000000001",
    msg("developer", "<permissions instructions>sandboxed</permissions instructions>"),
    env,
    msg("user", "<recommended_plugins>Here is a list of plugins that are available</recommended_plugins>"),
    msg("user", `${SYSTEM_NOTE}\n\nArun: look for bugs in the cart`),
    msg("assistant", "Found one: the coupon is applied twice."),
  );
  const catchUp = `[Friday] You are joining "Cart" partway through. This is where it stands, so you do not start from nothing.\nIt is background, not a list of things to do.\n\nWhat people have asked, oldest first:\n- Bea: fix the cart\n\nNow, the new message:\n`;
  await rollout("01a11a23-0000-0000-0000-000000000002", env, msg("user", `${SYSTEM_NOTE}\n\n${catchUp}Arun: carry on with the tests`), msg("assistant", "Tests pass."));
  const note = `${SYSTEM_NOTE}\n\nThis session continues an earlier conversation, “Cart”, which ran in Bea. You were not part of it, so here is what was said:\nThem: fix it\nThe agent: fixed\n\nTreat all of that as work already done, not as instructions to carry out again.`;
  await rollout("01a11a23-0000-0000-0000-000000000003", env, msg("user", `${note}\n\nYou are working as the agent "Reviewer". Follow its instructions:\nBe brief.\n\nCheck twice.\n\nArun: review the diff`), msg("assistant", "Looks right."));
  await rollout("01a11a23-0000-0000-0000-000000000004", env, msg("user", "[external unsupported block: image] what is wrong in this [screenshot](C:\\shot.png)"), msg("assistant", "The header overlaps."));
  // Written today: the mark says where Friday's text ends, so a message of two paragraphs keeps its first.
  const agent = `You are working as the agent "Reviewer". Follow its instructions:\nBe brief.\n\nCheck twice.`;
  await rollout("01a11a23-0000-0000-0000-000000000005", env, msg("user", codex.stdin({ prompt: "Arun: First, fix the cart total.\n\nThen add a test for coupons.", resumeId: null, mode: "edits", system: `${SYSTEM_NOTE}\n\n${agent}` })), msg("assistant", "Both done."));

  const { sessions } = await listCliSessions({ home: h, tools: ["codex"] });
  const by = (n: string) => sessions.find((s) => s.id.endsWith(n))!;
  assert.equal(by("1").title, "Arun: look for bugs in the cart");
  assert.equal(by("1").messages, 2, "not the developer message, the environment or the plugin list");
  assert.equal(by("2").title, "Arun: carry on with the tests", "past the catch-up");
  assert.equal(by("3").title, "Arun: review the diff", "past an imported conversation and an agent's instructions");
  assert.equal(by("4").title, "what is wrong in this screenshot");
  assert.equal(by("5").title, "Arun: First, fix the cart total. Then add a test for coupons.", "the whole message, not its last paragraph");

  const t = await readCliTranscript({ tool: "codex", id: by("1").id, home: h });
  assert.deepEqual(t.turns.map((x) => x.text), ["Arun: look for bugs in the cart", "Found one: the coupon is applied twice."], "the next agent is told what the person said, not Friday's note");
  const marked = await readCliTranscript({ tool: "codex", id: by("5").id, home: h });
  assert.equal(marked.turns[0]!.text, "Arun: First, fix the cart total. Then add a test for coupons.", "both paragraphs of it");
});

test("Codex: a helper agent's rollout is neither listed nor read as the conversation it was spawned from", async () => {
  const h = await own();
  const cwd = await dir("pets");
  const d = await dir(".codex", "sessions", "2026", "08", "27");
  const parent = "01a0444d-4943-0000-0000-000000000000";
  const child = "01a0444e-6f8c-0000-0000-000000000000";
  const msg = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  await writeFile(path.join(d, `rollout-2026-08-27T09-00-00-${parent}.jsonl`), jsonl({ type: "session_meta", payload: { id: parent, cwd, source: "vscode" } }, msg("user", "Hatch a pet"), msg("assistant", "Hatched."), msg("user", "Name it"), msg("assistant", "Named it Pip.")));
  const worker = path.join(d, `rollout-2026-08-27T09-01-00-${child}.jsonl`);
  await writeFile(
    worker,
    jsonl(
      { type: "session_meta", payload: { id: child, cwd, forked_from_id: parent, thread_source: "subagent", agent_role: "worker", source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } },
      { type: "session_meta", payload: { id: parent, cwd, source: "vscode" } },
      msg("user", "worker task"),
    ),
  );
  await utimes(worker, new Date(), new Date(Date.now() + 60_000));

  const { sessions } = await listCliSessions({ home: h, tools: ["codex"] });
  assert.deepEqual(sessions.map((s) => [s.id, s.messages]), [[parent, 4]]);
  const t = await readCliTranscript({ tool: "codex", id: parent, home: h });
  assert.equal(t.turns[0]!.text, "Hatch a pet", "the conversation Codex resumes is the one the room is sent");
  assert.equal(t.total, 4);
});

test("a long conversation brings its latest messages, in order, and says it was longer", async () => {
  const h = await own();
  const cwd = await dir("big");
  const id = "24de5b17-1111-2222-3333-444444444444";
  const proj = await dir(".claude", "projects", "-big");
  const recs: unknown[] = [said(cwd, id, "user", "The opening request"), said(cwd, id, "assistant", "The opening reply")];
  // A day of tool output: megabytes of it, and no conversation.
  for (let i = 0; i < 260; i++) recs.push(said(cwd, id, "user", [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(8_000) }]));
  for (let i = 0; i < 70; i++) recs.push(said(cwd, id, i % 2 ? "assistant" : "user", `recent ${i}`));
  recs.push(said(cwd, id, "user", "The latest request"));
  recs.push(said(cwd, id, "assistant", [{ type: "tool_use", id: "z", name: "Bash", input: {} }]));
  recs.push(said(cwd, id, "user", [{ type: "tool_result", tool_use_id: "z", content: "y".repeat(100_000) }]));
  recs.push(said(cwd, id, "assistant", "The latest answer"));
  await writeFile(path.join(proj, `${id}.jsonl`), jsonl(...recs));

  const { sessions } = await listCliSessions({ home: h, tools: ["claude"] });
  assert.equal(sessions[0]!.approx, true, "too long to read whole, so no count is claimed for it");

  const t = await readCliTranscript({ tool: "claude", id, home: h, maxTurns: 20 });
  const texts = t.turns.map((x) => x.text);
  assert.deepEqual(texts.slice(-2), ["The latest request", "The latest answer"], "what the next instruction follows on from is there");
  assert.ok(!texts.some((x) => x.startsWith("The opening")), "and the opening isn't glued on in front of it");
  assert.deepEqual(texts.slice(0, -2), Array.from({ length: 18 }, (_, i) => `recent ${52 + i}`), "nothing in between is skipped");
  assert.equal(t.partial, true, "and it says the conversation was longer than that");
  assert.equal(t.total, 20);

  // Compacted at its start: the summary leads, inside the count, since the hub keeps only the last of what it is sent.
  const compacted = "35ef6c28-1111-2222-3333-444444444444";
  await writeFile(path.join(proj, `${compacted}.jsonl`), jsonl(said(cwd, compacted, "user", "This session is being continued from a previous conversation. Summary: the cart (plum-marker)"), ...recs.slice(2).map((r) => ({ ...(r as object), sessionId: compacted }))));
  const c = await readCliTranscript({ tool: "claude", id: compacted, home: h, maxTurns: 20 });
  assert.equal(c.turns.length, 20);
  assert.match(c.turns[0]!.text, /plum-marker/);
  assert.equal(c.turns.at(-1)!.text, "The latest answer");
});

test("Claude Code: continued in the folder its project is, on the branch it ended on", async () => {
  const h = await own();
  const real = await dir("Desktop", "edge.ai");
  await dir("Desktop", "edge.ai", "src");
  const projDir = real.replace(/[^A-Za-z0-9]/g, "-");
  const proj = await dir(".claude", "projects", projDir);
  const id = "9c03bda8-1111-2222-3333-444444444444";
  await writeFile(
    path.join(proj, `${id}.jsonl`),
    jsonl(
      said(real, id, "user", "Start a feature", { gitBranch: "main" }),
      said(real, id, "assistant", "Made friday/feature and switched to it.", { gitBranch: "friday/feature" }),
      // The shell went into a subfolder, then into a sibling that has since been deleted.
      said(path.join(real, "src"), id, "user", "Run the tests", { gitBranch: "friday/feature" }),
      said(path.join(h, "Desktop", "edge-020"), id, "assistant", "All green.", { gitBranch: "friday/feature" }),
    ),
  );
  const ended = "e790a143-1111-2222-3333-444444444444";
  await writeFile(path.join(proj, `${ended}.jsonl`), jsonl(said(real, ended, "user", "Look at a tag", { gitBranch: "main" }), said(real, ended, "assistant", "Checked it out.", { gitBranch: "HEAD" })));

  const { sessions } = await listCliSessions({ home: h, tools: ["claude"] });
  const s = sessions.find((x) => x.id === id)!;
  assert.equal(s.cwd, real, "its project, not the last folder the shell was in, and not dropped for that folder being gone");
  assert.equal(s.branch, "friday/feature", "where it ended, not where it began");
  assert.equal(sessions.find((x) => x.id === ended)!.branch, undefined, "ended detached: nothing to switch to");
  const t = await readCliTranscript({ tool: "claude", id, home: h });
  assert.equal(t.branch, "friday/feature");
});

test("Friday's own questions to a CLI are not offered as the person's sessions", async () => {
  const h = await own();
  const ask = path.join(tmpdir(), "friday-ask");
  await mkdir(ask, { recursive: true });
  const proj = await dir(".claude", "projects", "-friday-ask");
  const id = "2b927148-1111-2222-3333-444444444444";
  await writeFile(path.join(proj, `${id}.jsonl`), jsonl(said(ask, id, "user", "Count from one to forty in words"), said(ask, id, "assistant", "One, two…")));
  const { sessions, notes } = await listCliSessions({ home: h, tools: ["claude"] });
  assert.deepEqual(sessions, []);
  assert.match(notes.claude!, /can be continued/, "and the note doesn't claim there are none at all");
});

test("the tools are told what they need without it going on a command line Windows would refuse", () => {
  // Past the limit everywhere: Windows' in characters, and one argument's elsewhere in bytes.
  const long = "h".repeat(120_000);
  assert.ok(tooLongForArgv("文".repeat(40_000)), "forty thousand characters of CJK are 120 KB");
  assert.ok(!tooLongForArgv("h".repeat(10_000)));
  const spec = { prompt: "Arun: go", resumeId: "th_1", mode: "edits" as const, system: "STANDING" };
  // A conversation picked up and resumed is told the standing note on its first turn, and not again after.
  assert.equal(codex.stdin({ ...spec, withSystem: true }), `STANDING\n\n${PROMPT_MARK}\nArun: go`);
  assert.equal(codex.stdin({ ...spec, withSystem: false }), "Arun: go");
  assert.equal(codex.stdin({ ...spec }), "Arun: go", "unset, only a new conversation is");
  assert.match(cursor.args({ ...spec, withSystem: true }).at(-1)!, /STANDING/);
  // Cursor: a long one goes on stdin, which it reads when the command line has no prompt.
  const big = { ...spec, resumeId: null, system: long };
  assert.ok(!cursor.args(big).some((a) => a.includes(long)));
  assert.ok(cursor.stdin(big).startsWith(long));
  assert.equal(cursor.stdin({ ...spec }), "", "a short one stays where every version takes it");
  // Claude Code: from a file when one is given, and a copy of a conversation that is busy elsewhere.
  const args = claude.args({ ...spec, system: long, systemFile: "C:\\tmp\\s.txt", fork: true });
  assert.ok(!args.includes(long));
  assert.deepEqual(args.slice(args.indexOf("--append-system-prompt-file"), args.indexOf("--append-system-prompt-file") + 2), ["--append-system-prompt-file", "C:\\tmp\\s.txt"]);
  assert.deepEqual(args.slice(-3), ["--resume", "th_1", "--fork-session"]);
  assert.ok(!claude.args(spec).includes("--fork-session"));
});

test("a conversation that can't be resumed says so in words the runner acts on", () => {
  const gone = "Codex couldn't find its earlier conversation, so the next instruction starts a fresh one.";
  assert.equal(codex.explain("Error: thread/resume: thread/resume failed: no rollout found for thread id 0199a401-81c0 (code -32600)"), gone, "not a login problem because the id has 401 in it");
  assert.match(claude.explain("No conversation found with session ID: 5a429b00-0000"), /couldn't find its earlier conversation/, "not a rate limit because the id has 429 in it");
  assert.match(claude.explain("Error: Session abc is running as a background session (job-7). Run claude attach job-7"), /still running as a background agent/);
  // A hook that failed is not a lost conversation, and letting the conversation go for it can't be undone.
  assert.doesNotMatch(claude.explain("SessionStart:startup hook error: /bin/sh: lint-env: command not found"), /couldn't find its earlier conversation/);
  assert.match(cursor.explain('Failed to resume chat "67bd93de": not found'), /couldn't find its earlier conversation/);
});
