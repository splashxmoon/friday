import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Redis } from "ioredis";
import { answerAsk, badCitations, buildDive, citationsIn, cleanPage, DeepDives, diveModel, fallbackOutline, mermaidOk, pagesFor, parseOutline, strikeBad, unDraw, uncoveredFolders, type Dive, type DiveSurvey } from "../src/deep-dive.js";
import { citedLines, countLines, folderOf, lineCounts, surveyRepo } from "../src/runner/dive.js";
import { rangeEnd } from "../src/client/DeepDive.js";

/** Deep Dive (deep-dive.ts, runner/dive.ts; Arun, 2026-11-11: "Repo wiki and Q&A … Deep Dive is what we should call it"). */

const fakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    hget: async (k: string, f: string) => h(k).get(f) ?? null,
    hset: async (k: string, f: string, v: string) => void h(k).set(f, v),
    hdel: async (k: string, ...fs: string[]) => void fs.forEach((f) => h(k).delete(f)),
    hgetall: async (k: string) => Object.fromEntries(h(k)),
    get: async (k: string) => strings.get(k) ?? null,
    set: async (k: string, v: string) => void strings.set(k, v),
    del: async (...ks: string[]) => void ks.forEach((k) => (strings.delete(k), hashes.delete(k))),
  } as unknown as Redis;
};

const survey = (over: Partial<DiveSurvey> = {}): DiveSurvey => ({
  files: ["README.md", "src/server.ts", "src/db.ts", "src/routes/users.ts", "web/app.tsx", "scripts/seed.ts"],
  more: false,
  folders: [
    { path: ".", files: 1, lines: 20, changes: 2 },
    { path: "src", files: 2, lines: 400, changes: 9 },
    { path: "src/routes", files: 1, lines: 120, changes: 4 },
    { path: "web", files: 1, lines: 300, changes: 6 },
    { path: "scripts", files: 1, lines: 80, changes: 1 },
  ],
  lines: 920,
  head: "abc1234def",
  branch: "main",
  remote: { url: "", github: null },
  docs: [{ name: "README.md", text: "# Acme\nA small app." }],
  ...over,
});

test("citations: path:line and path:start-end in backticks, Windows backslashes read as slashes, code samples and addresses left alone", () => {
  const md = [
    "The server starts in `src/server.ts:10-24` and talks to `src\\db.ts:5`.",
    "It listens on `localhost:8080` and logs `console.log:3`, never `/etc/hosts:1`.",
    "```ts\nconst x = `src/fake.ts:1`;\n```",
    "The `Dockerfile:3` builds it.",
  ].join("\n");
  const c = citationsIn(md);
  assert.deepEqual(
    c.map((x) => [x.file, x.start, x.end]),
    [
      ["src/server.ts", 10, 24],
      ["src/db.ts", 5, 5],
      ["Dockerfile", 3, 3],
    ],
  );
});

test("a citation is bad when its file isn't there, its lines run past the end, or its range is backwards; bad ones are struck through and said", () => {
  const md = "Starts at `src/server.ts:10-24`, reads `src/db.ts:90-99`, uses `src/gone.ts:1` and `src/db.ts:9-3`.\n\n```\n`src/gone.ts:1`\n```";
  const bad = badCitations(citationsIn(md), { "src/server.ts": 40, "src/db.ts": 50, "src/gone.ts": null });
  assert.deepEqual(bad, ["src/db.ts:90-99", "src/gone.ts:1", "src/db.ts:9-3"]);
  const struck = strikeBad(md, bad);
  assert.match(struck, /`src\/server\.ts:10-24`/, "a good citation stays a citation");
  assert.match(struck, /~~src\/gone\.ts:1~~ \*\(not in the code\)\*/);
  assert.match(struck, /```\n`src\/gone\.ts:1`\n```/, "inside a code sample nothing is touched");
  assert.equal(citationsIn(struck).length, 1, "only the good one is still a citation");
});

test("diagrams: a known kind with its brackets and quotes closed is drawn; one that isn't is shown as its text", () => {
  assert.ok(mermaidOk('flowchart TD\n  A["Browser"] --> B["Server (Node)"]\n  B --> C[(Postgres)]'));
  assert.ok(mermaidOk("sequenceDiagram\n  A->>B: hello"));
  assert.ok(!mermaidOk("flowchart TD\n  A[Browser --> B"), "an open bracket");
  assert.ok(!mermaidOk('flowchart TD\n  A["Browser] --> B'), "an open quote");
  assert.ok(!mermaidOk("not a diagram\nA --> B"), "no kind");
  const md = "Before.\n\n```mermaid\nflowchart TD\n  A[x --> B\n```\n\nAnd\n\n```mermaid\nflowchart LR\n  A --> B\n```";
  const out = unDraw(md);
  assert.match(out, /A diagram Friday couldn't draw:\*\n\n```text\nflowchart TD/);
  assert.match(out, /```mermaid\nflowchart LR/, "the good one stays a diagram");
});

test("the outline keeps only files really in the repo, puts the overview first and the glossary last, and gives up on an answer with no outline", () => {
  const text = `Here is the plan:\n[{"id":"api","title":"The API","purpose":"Routes.","files":["src/routes/users.ts","src\\\\server.ts","src/nope.ts"]},{"id":"glossary","title":"Glossary","purpose":"Terms","files":[]},{"id":"overview","title":"Overview","purpose":"All of it","files":["README.md"]},{"id":"api","title":"The API again","files":[]}]`;
  const plan = parseOutline(text, survey())!;
  assert.deepEqual(
    plan.map((p) => p.id),
    ["overview", "api", "api-2", "glossary"],
  );
  assert.deepEqual(plan[1]!.files, ["src/routes/users.ts", "src/server.ts"]);
  assert.equal(parseOutline("I couldn't read the repo.", survey()), null);
  assert.equal(parseOutline("[1, 2", survey()), null);
  const fb = fallbackOutline(survey());
  assert.equal(fb[0]!.id, "overview");
  assert.equal(fb.at(-1)!.id, "glossary");
  assert.ok(fb.some((p) => p.title === "src"));
  assert.equal(pagesFor(500), 5);
  assert.equal(pagesFor(390_000), 18);
});

test("what no page covers is said, biggest first; tiny folders and the repo's top aren't", () => {
  const plan = [
    { id: "overview", title: "Overview", purpose: "", files: ["README.md"] },
    { id: "server", title: "Server", purpose: "", files: ["src/server.ts"] },
  ];
  assert.deepEqual(
    uncoveredFolders(survey(), plan).map((u) => u.path),
    ["web", "src/routes", "scripts"],
  );
});

test("a page's wrapping comes off: a fence round the whole of it, and the title heading it was told not to add", () => {
  assert.equal(cleanPage("```markdown\n# Server\n\nIt serves.\n```"), "It serves.");
  assert.equal(cleanPage("It serves.\n\n## How"), "It serves.\n\n## How");
});

test("a citation pressed in a page opens its whole range, found where the page wrote it", () => {
  const text = "See `src/server.ts:10-24` and `src/db.ts:5`.";
  assert.equal(rangeEnd(text, "src/server.ts", 10), 24);
  assert.equal(rangeEnd(text, "src/db.ts", 5), 5);
  assert.equal(rangeEnd(text, "src/server.ts", 11), 11);
});

test("on the computer: lines counted as an editor does (CRLF too), folders two levels deep, nothing outside the folder or secret read", async () => {
  assert.equal(countLines("a\r\nb\r\nc"), 3);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines(""), 0);
  assert.equal(folderOf("README.md"), ".");
  assert.equal(folderOf("src/a.ts"), "src");
  assert.equal(folderOf("src/runner/deep/a.ts"), "src/runner");
  const dir = await mkdtemp(path.join(tmpdir(), "dive-"));
  try {
    await mkdir(path.join(dir, "src", "routes"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(dir, "README.md"), "# Acme\n\nA small app.\n");
    await writeFile(path.join(dir, "src", "server.ts"), "line1\r\nline2\r\nline3\r\n");
    await writeFile(path.join(dir, "src", "routes", "users.ts"), Array.from({ length: 30 }, (_, i) => `// ${i + 1}`).join("\n"));
    await writeFile(path.join(dir, ".env"), "SECRET=1\n");
    await writeFile(path.join(dir, "node_modules", "x", "i.js"), "x\n");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "README.md", "src"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"], { cwd: dir });
    const s = await surveyRepo(dir);
    assert.ok(s.files.includes("src/routes/users.ts") && s.files.includes("README.md"));
    assert.ok(!s.files.some((f) => f.startsWith("node_modules")), "node_modules is left out");
    assert.equal(s.folders.find((f) => f.path === "src")!.lines, 3);
    assert.equal(s.folders.find((f) => f.path === "src/routes")!.lines, 30);
    assert.equal(s.folders.find((f) => f.path === "src")!.changes, 1);
    assert.match(s.head, /^[0-9a-f]{40}$/);
    assert.equal(s.docs[0]!.name, "README.md");
    const counts = await lineCounts(dir, ["src/server.ts", "src\\routes\\users.ts", "../etc/passwd", ".env", "src/nope.ts", ".git/config"]);
    assert.deepEqual(counts, { "src/server.ts": 3, "src/routes/users.ts": 30, "../etc/passwd": null, ".env": null, "src/nope.ts": null, ".git/config": null });
    const lines = await citedLines(dir, "src/routes/users.ts", 20, 22, 2);
    assert.equal(lines.from, 18);
    assert.deepEqual(lines.lines, ["// 18", "// 19", "// 20", "// 21", "// 22", "// 23", "// 24"]);
    await assert.rejects(citedLines(dir, ".env", 1), /isn't one Deep Dive shows/);
    await assert.rejects(citedLines(dir, "../x", 1), /isn't one Deep Dive shows/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a whole build: survey, outline, pages written six at a time, each given its files, a bad citation asked about once and fixed, one that stays wrong struck through, a failed page said, and a question answered", async () => {
  const store = new DeepDives(fakeRedis(), "t:");
  const asked: string[] = [];
  let atOnce = 0;
  let most = 0;
  const host = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "dive.survey") return { survey: survey() };
    if (method === "dive.lines") return { counts: Object.fromEntries((params.files as string[]).map((f) => [f, f === "src/server.ts" ? 40 : f === "web/app.tsx" ? 60 : null])) };
    if (method === "dive.files") return { files: (params.files as string[]).map((f) => ({ file: f, text: "1| first line\n", total: 1, cut: false })) };
    assert.equal(method, "ask");
    assert.equal(params.cwd, "/repo/acme");
    const prompt = String(params.prompt);
    asked.push(prompt.split("\n")[0]!);
    atOnce++;
    most = Math.max(most, atOnce);
    await new Promise((r) => setTimeout(r, 5));
    atOnce--;
    if (prompt.startsWith("Plan the Deep Dive")) return { text: JSON.stringify([{ id: "overview", title: "Overview", purpose: "All", files: ["README.md"] }, { id: "server", title: "Server", purpose: "How it serves", files: ["src/server.ts"] }, { id: "web", title: "Web", purpose: "The page", files: ["web/app.tsx"] }, { id: "broken", title: "Broken", purpose: "x", files: [] }, { id: "glossary", title: "Glossary", purpose: "Terms", files: [] }]) };
    if (prompt.includes('"Broken"')) throw new Error("Claude Code exited with code 1.");
    if (prompt.startsWith("Some of your page \"Server\"")) return { text: "It serves from `src/server.ts:1-20`." };
    if (prompt.startsWith("Some of your page \"Web\"")) return { text: "It draws in `web/app.tsx:1-10` and `web/gone.tsx:4`." };
    if (prompt.includes('page "Server"')) return { text: "It serves from `src/server.ts:1-90`." };
    if (prompt.includes('page "Web"')) return { text: "It draws in `web/app.tsx:1-10` and `web/gone.tsx:4`." };
    if (prompt.startsWith("Someone working on")) return { text: "Users are saved in `src/server.ts:30-35` and `src/nowhere.ts:1`." };
    return { text: "```mermaid\nflowchart TD\n  A --> B\n```\n\nAll of it, in `src/server.ts:2`." };
  };
  const d: Dive = { key: "folder:acme", name: "acme", folder: "/repo/acme", tool: "claude", by: "me", status: "building", stage: "survey", head: "", branch: "", files: 0, lines: 0, started: 1, at: 1, done: 0, total: 0, uncovered: [] };
  await buildDive(store, host, d);
  const meta = (await store.get("folder:acme"))!;
  assert.equal(meta.status, "ready");
  assert.equal(meta.total, 5);
  assert.equal(meta.done, 5);
  assert.equal(meta.head, "abc1234def");
  assert.ok(most <= 6, `at most six pages at once (${most})`);
  assert.deepEqual(
    meta.uncovered.map((u) => u.path),
    ["src/routes", "scripts"],
  );
  const pages = await store.pages("folder:acme");
  assert.deepEqual(
    pages.map((p) => [p.id, p.status]),
    [
      ["overview", "done"],
      ["server", "done"],
      ["web", "done"],
      ["broken", "failed"],
      ["glossary", "done"],
    ],
  );
  const server = pages.find((p) => p.id === "server")!;
  assert.deepEqual(server.bad, [], "fixed on the second try");
  assert.match(server.body, /`src\/server\.ts:1-20`/);
  const web = pages.find((p) => p.id === "web")!;
  assert.deepEqual(web.bad, ["web/gone.tsx:4"]);
  assert.match(web.body, /~~web\/gone\.tsx:4~~ \*\(not in the code\)\*/);
  assert.match(pages.find((p) => p.id === "broken")!.error!, /exited with code 1/);
  assert.equal(asked.filter((a) => a.startsWith("Some of your page")).length, 2, "asked again only for the pages that needed it");

  const ask = { id: "q1", question: "Where are users saved?", answer: "", bad: [], by: "me", at: 2, status: "asking" as const };
  await store.saveAsk("folder:acme", ask);
  await answerAsk(store, host, meta, ask);
  const [a] = await store.asks("folder:acme");
  assert.equal(a!.status, "done");
  assert.deepEqual(a!.bad, ["src/nowhere.ts:1"]);
  assert.match(a!.answer, /`src\/server\.ts:30-35`/);

  // A survey that fails fails the build, with why.
  await buildDive(store, async () => Promise.reject(new Error("There's no folder at /repo/acme.")), { ...d, key: "folder:gone" });
  const gone = (await store.get("folder:gone"))!;
  assert.equal(gone.status, "failed");
  assert.match(gone.error!, /no folder/);

  // An outline it can't read still gives pages: one per big folder.
  const plain = new DeepDives(fakeRedis(), "t:");
  await buildDive(plain, async (m, p) => (m === "dive.survey" ? { survey: survey() } : m === "dive.lines" ? { counts: {} } : String(p.prompt).startsWith("Plan") ? { text: "Sorry, no." } : { text: "Plain words." }), { ...d, key: "folder:plain" });
  const fbPages = await plain.pages("folder:plain");
  assert.ok(fbPages.length >= 3 && fbPages.every((p) => p.status === "done"));
  await store.remove("folder:acme");
  assert.equal(await store.get("folder:acme"), null);
  assert.deepEqual(await store.pages("folder:acme"), []);
});

test("written on each tool's small model unless one was picked, and on the tool's own default when it turns the small one down", async () => {
  assert.equal(diveModel("claude"), "haiku");
  assert.equal(diveModel("codex"), "gpt-6-luna");
  assert.equal(diveModel("cursor"), undefined);
  assert.equal(diveModel("claude", "opus"), "opus");
  const d: Dive = { key: "folder:small", name: "small", folder: "/repo/small", tool: "codex", by: "me", status: "building", stage: "survey", head: "", branch: "", files: 0, lines: 0, started: 1, at: 1, done: 0, total: 0, uncovered: [] };
  const models: (string | undefined)[] = [];
  const host = async (m: string, p: Record<string, unknown>): Promise<unknown> => {
    if (m === "dive.survey") return { survey: survey() };
    if (m === "dive.lines") return { counts: {} };
    if (m === "dive.files") return { files: [] };
    models.push(p.model as string | undefined);
    if (p.model === "gpt-6-luna") throw new Error("The model `gpt-6-luna` does not exist or you do not have access to it.");
    return { text: String(p.prompt).startsWith("Plan") ? "Sorry, no." : "Plain words." };
  };
  const store = new DeepDives(fakeRedis(), "t:");
  await buildDive(store, host, d);
  assert.equal((await store.get("folder:small"))!.status, "ready");
  assert.equal(models[0], "gpt-6-luna", "the small model is asked first");
  assert.equal(models[1], undefined, "then the tool's own default");
  const picked: (string | undefined)[] = [];
  await buildDive(new DeepDives(fakeRedis(), "u:"), async (m, p) => (m === "dive.survey" ? { survey: survey() } : m === "dive.lines" ? { counts: {} } : m === "dive.files" ? { files: [] } : (picked.push(p.model as string), { text: "Plain words." })), { ...d, tool: "claude", model: "opus" });
  assert.ok(picked.length && picked.every((x) => x === "opus"), "a picked model is used as it is");
});

test("a page's files are read on the computer and handed over numbered, cut where they run long, never a secret or outside the folder", async () => {
  const { readForPage } = await import("../src/runner/dive.js");
  const dir = await mkdtemp(path.join(tmpdir(), "dive-files-"));
  try {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src/a.ts"), "one\r\ntwo\r\n");
    await writeFile(path.join(dir, "src/big.ts"), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n"));
    await writeFile(path.join(dir, ".env"), "KEY=secret");
    const got = await readForPage(dir, ["src/a.ts", "src\\big.ts", ".env", "../x", "src/none.ts"]);
    assert.deepEqual(got.map((g) => g.file), ["src/a.ts", "src/big.ts"]);
    assert.equal(got[0]!.text, "1| one\n2| two\n");
    assert.equal(got[0]!.cut, false);
    assert.equal(got[1]!.total, 5000);
    assert.ok(got[1]!.cut && got[1]!.text.length <= 16_000 && got[1]!.text.startsWith("1| line 1\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting: a question goes, an answer still coming doesn't bring it back, and a Deep Dive deleted while it is written stops writing", async () => {
  const store = new DeepDives(fakeRedis(), "del:");
  const d: Dive = { key: "folder:acme", name: "acme", folder: "/repo/acme", tool: "claude", by: "me", status: "building", stage: "survey", head: "", branch: "", files: 0, lines: 0, started: 7, at: 7, done: 0, total: 0, uncovered: [] };
  await store.saveMeta(d);
  const q = (id: string) => ({ id, question: `q ${id}`, answer: "", bad: [], by: "me", at: 1, status: "asking" as const });
  await store.saveAsk(d.key, q("a"));
  await store.saveAsk(d.key, q("b"));
  assert.equal(await store.removeAsk(d.key, "a"), true);
  assert.equal(await store.removeAsk(d.key, "a"), false);
  assert.equal(await store.updateAsk(d.key, { ...q("a"), status: "done", answer: "late" }), false, "a deleted question's answer is dropped");
  assert.deepEqual((await store.asks(d.key)).map((a) => a.id), ["b"]);
  assert.equal(await store.updateAsk(d.key, { ...q("b"), status: "done", answer: "kept" }), true);
  assert.equal((await store.asks(d.key))[0]!.answer, "kept");
  await store.clearAsks(d.key);
  assert.deepEqual(await store.asks(d.key), []);

  let pagesAsked = 0;
  const host = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "dive.survey") return { survey: survey() };
    if (method === "dive.lines") return { counts: {} };
    if (method === "dive.files") return { files: [] };
    if (String(params.prompt).startsWith("Plan the Deep Dive")) {
      await store.remove(d.key); // deleted while it plans
      return { text: JSON.stringify([{ id: "overview", title: "Overview", purpose: "All", files: [] }, { id: "glossary", title: "Glossary", purpose: "Terms", files: [] }]) };
    }
    pagesAsked++;
    return { text: "Words." };
  };
  await buildDive(store, host, d);
  assert.equal(await store.get(d.key), null, "not brought back");
  assert.deepEqual(await store.pages(d.key), []);
  assert.equal(pagesAsked, 0, "no page written once it was deleted");

  // Written again while an older build of it was still going: the older one stops.
  const fresh = { ...d, started: 9 };
  await store.saveMeta(d);
  const host2 = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === "dive.survey") return { survey: survey() };
    if (String(params.prompt).startsWith("Plan the Deep Dive")) {
      await store.saveMeta(fresh);
      return { text: "[]" };
    }
    return { text: "Words." };
  };
  await buildDive(store, host2, d);
  assert.equal((await store.get(d.key))!.started, 9);
  assert.equal((await store.get(d.key))!.status, "building", "the newer build's record is left alone");
});
