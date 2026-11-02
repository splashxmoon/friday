// Project memory in the open-source edition (Arun, 2026-11-02: "Yes, bring it to OSS"): with no model of Friday's own, a run is
// read for what it taught by the coding tool that did it, on this computer; a run that began with a correction becomes one, and
// the lesson, its count and its check are the person's to tend on this computer's Memory page.
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAIN_LANE } from "../src/types.js";

// A Claude Code that only answers a question (runner/ask.ts runs it in a scratch folder named friday-ask): what it was asked is
// kept, and a run that began with a correction is filed as one, with the command that would catch it.
const FAKE = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import path from "node:path";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (path.basename(process.cwd()) !== "friday-ask") process.exit(1);
  appendFileSync(process.env.FAKE_ASK_LOG, input + "\\n---\\n");
  const answer = input.includes("How this run began:") ? JSON.stringify([{ key: "migrate-first", kind: "correction", text: "Run npm run db:migrate before the API tests: agents keep skipping it.", check: "node check.mjs" }]) : "[]";
  out({ type: "system", subtype: "init", session_id: "ask", cwd: process.cwd() });
  out({ type: "assistant", message: { content: [{ type: "text", text: answer }] }, parent_tool_use_id: null });
  out({ type: "result", subtype: "success", is_error: false, result: answer, session_id: "ask" });
});
`;

test("on this computer, a run that began with a correction is read by its own coding tool and kept as one, to tend on the Memory page", async (t) => {
  process.env.FRIDAY_LOCAL_RUNNER = "0";
  const home = await mkdtemp(path.join(tmpdir(), "friday-local-brain-"));
  const fake = path.join(home, "fake-claude.mjs");
  await writeFile(fake, FAKE);
  await chmod(fake, 0o755);
  const log = path.join(home, "asked.txt");
  await writeFile(log, "");
  const had = { bin: process.env.FRIDAY_CLAUDE_BIN, log: process.env.FAKE_ASK_LOG };
  process.env.FRIDAY_CLAUDE_BIN = fake;
  process.env.FAKE_ASK_LOG = log;
  const { createApp } = await import("../src/app.js");
  const { localKV } = await import("../src/local/kv.js");
  const { NO_MODELS } = await import("../src/local/no-models.js");
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, decisionLog: true, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
  t.after(async () => {
    await app.close();
    await kv.close();
    await rm(home, { recursive: true, force: true });
    for (const [k, v] of [["FRIDAY_CLAUDE_BIN", had.bin], ["FAKE_ASK_LOG", had.log]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
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

  const { sessionId: sid } = await call<{ sessionId: string }>("/api/sessions", "POST", { title: "Orders API" });
  const me = { id: "local", name: "Me", kind: "human" as const };
  const claude = { id: "agent", name: "Claude Code", kind: "agent" as const };
  await app.store.append(sid, claude, { type: "engine.attached", engine: { tool: "claude", hostId: "local", hostName: "Me", cwd: path.join(home, "shop"), mode: "full" } } as never);
  const turn = async (text: string) => {
    await app.store.append(sid, me, { type: "instruction", text, interrupt: false });
    await app.store.append(sid, claude, { type: "run.started" } as never);
    await app.store.append(sid, claude, { type: "agent.message", text: "Done: the orders API is in.", toolCalls: [{ id: "t1", name: "Edit", arguments: "{}" }] } as never);
    await app.store.append(sid, claude, { type: "run.ended", outcome: "done" });
  };
  type Entry = { id: string; kind: string; seen?: number; check?: { state: string; command: string } };
  const entries = async () => (await call<{ entries: Entry[] }>(`/api/brain/entries?repo=${encodeURIComponent("folder:shop")}`)).entries;

  // A first run with one tool call is too slight to read; the correction after it is read however small.
  await turn("Add the orders API");
  await turn("Still failing: you didn't run the migrations first.");
  await until("the correction to be learned", async () => (await entries()).some((e) => e.kind === "correction"));
  const asked = await readFile(log, "utf8");
  assert.match(asked, /How this run began:/);
  assert.match(asked, /Me wrote: \\?"Still failing: you didn't run the migrations first\.\\?"/, "the tool was told how the run began");
  let [e] = await entries();
  assert.deepEqual([e!.seen, e!.check?.state, e!.check?.command], [1, "suggested", "node check.mjs"]);

  // The same mistake again counts up rather than adding a second lesson.
  await turn("Same thing again: the migrations.");
  await until("it to count twice", async () => (await entries())[0]?.seen === 2);
  assert.equal((await entries()).length, 1);

  // This computer's Memory page: the repository is listed, and its check is added from there.
  const { repos } = await call<{ enabled: boolean; repos: { key: string; name: string; count: number }[] }>("/api/brain");
  assert.deepEqual(repos.map((r) => [r.key, r.name, r.count]), [["folder:shop", "shop", 1]]);
  e = (await call<{ entry: Entry }>(`/api/brain/check?repo=${encodeURIComponent("folder:shop")}&id=${e!.id}`, "POST", { take: true })).entry;
  assert.equal(e.check?.state, "added");

  // Turned off: nothing more is read.
  await call("/api/brain/settings", "POST", { enabled: false });
  const before = (await readFile(log, "utf8")).length;
  await turn("Wrong again, the migrations.");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await readFile(log, "utf8")).length, before);
});
