// The logic under a Work session's rail and reader (client/work-outputs.ts) and the pass a page an agent made reads its own
// pictures by (work-frame.ts) (Arun, 2026-10-28: "iron everything and ensure we are good… focusing on UI and UX and any logic
// errors").
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { localKV } from "../src/local/kv.js";
import { NO_MODELS } from "../src/local/no-models.js";
import { verifyInvite } from "../src/auth.js";
import { FRAME_TTL_MS, frameDir, inFrame, signFrame, verifyFrame } from "../src/work-frame.js";
import { fromTop, frameScope, galleryOf, matchFile, resolveFrom, safeDecode, sentIn, sheetRows, sourcesIn, workPoller, workRightNow, learnTitles, chipTitle, chipLabel, titlesChanged, titlesNow, wordCount, headingOf, type Listed } from "../src/client/work-outputs.js";
import type { WorkFile } from "../src/client/WorkPanels.js";

const said = (text: string) => ({ body: { type: "agent.message", text, toolCalls: [] } }) as never;
const file = (p: string, more: Partial<WorkFile> = {}): WorkFile => ({ root: 0, path: p, kind: /\.(png|jpe?g)$/.test(p) ? "image" : "doc", size: 1, mtime: 1, ...more });

test("pictures named in the chat are found as each is written: plain paths without spaces, backticks and <…> with them, any script", () => {
  assert.deepEqual(sentIn([said("Saved renders/hero.png and renders/alt.png.")]), ["renders/hero.png", "renders/alt.png"], "two pictures, not one long path");
  assert.deepEqual(sentIn([said("It's in `my renders/a b.png` now")]), ["my renders/a b.png"]);
  assert.deepEqual(sentIn([said("![cover](<cover art.png>)")]), ["cover art.png"]);
  assert.deepEqual(sentIn([said('![cover](out/c.png "the cover")')]), ["out/c.png"]);
  assert.deepEqual(sentIn([said("Made héro.png and 封面.webp!")]), ["héro.png", "封面.webp"]);
  assert.deepEqual(sentIn([said("(see out/clip.mp4)")]), ["out/clip.mp4"]);
  assert.deepEqual(sentIn([said("Saved ~/Desktop/shot.png, and ./y.jpg")]), ["~/Desktop/shot.png", "y.jpg"]);
  assert.deepEqual(sentIn([said("No pictures here.png-ish, nor in report.md")]), []);
  const e = said("Saved a.png");
  assert.equal(sentIn([e, e]).length, 1, "the same picture once");
});

test("a link with a stray % or a # in its name never stops a document drawing, and links in code stay code", () => {
  assert.equal(safeDecode("50%off.md"), "50%off.md");
  assert.equal(safeDecode("caf%C3%A9.md"), "café.md");
  assert.equal(resolveFrom("drafts/x.md", "50%off.md"), "drafts/50%off.md", "no URIError");
  assert.equal(resolveFrom("drafts/x.md", "../brief.md#top"), "brief.md");
  assert.equal(fromTop("[deal](50%off.md)", "notes/x.md"), "[deal](/notes/50%25off.md)");
  assert.equal(fromTop("[a](<my notes.md>)", "x.md"), "[a](/my%20notes.md)", "a name with spaces, in <…>");
  assert.equal(fromTop("[a](q%23a.md)", "x.md"), "[a](/q%23a.md)", "a # in a name is part of the name");
  assert.equal(fromTop("[web](https://x.com/a) [here](#top)", "x.md"), "[web](https://x.com/a) [here](#top)");
  assert.equal(fromTop("```\n[a](b.md)\n```\nand `[c](d.md)` and [e](f.md)", "n/x.md"), "```\n[a](b.md)\n```\nand `[c](d.md)` and [e](/n/f.md)");
  assert.equal(resolveFrom("", "/q%23a.md"), "q#a.md", "read back as the file it names");
});

test("a file named in the chat opens the one it means: exact, then its full path, then the nearest that ends in it", () => {
  const list = { roots: ["/w"], files: [file("notes/README.md", { mtime: 9 }), file("README.md"), file("a/b/brief.md", { mtime: 5 }), file("c/brief.md", { mtime: 1 })] };
  assert.equal(matchFile(list, "README.md")?.path, "README.md", "not notes/README.md, listed first");
  assert.equal(matchFile(list, "./README.md")?.path, "README.md");
  assert.equal(matchFile(list, "/w/notes/README.md")?.path, "notes/README.md");
  assert.equal(matchFile(list, "brief.md")?.path, "c/brief.md", "the one nearest the top");
  assert.equal(matchFile(list, "b/brief.md")?.path, "a/b/brief.md");
  assert.equal(matchFile(list, "rief.md"), null, "never part of a name");
  assert.equal(matchFile({ roots: ["/w"], files: [file("héro.md")] }, "héro.md")?.path, "héro.md", "the same letters however they were stored");
});

test("a picture opens among the others in its folder, itself always among them", () => {
  const a = file("art/a2.png");
  const g = galleryOf(a, [file("art/a10.png"), file("art/a1.png"), file("other/z.png"), file("art/notes.md")]);
  assert.deepEqual(g.files.map((f) => f.path), ["art/a1.png", "art/a2.png", "art/a10.png"]);
  assert.equal(g.at, 1);
  const lone = galleryOf(a, []);
  assert.deepEqual([lone.files.length, lone.at], [1, 0], "a picture the list doesn't have yet still opens");
});

test("a sheet's rows are found with their own numbers, and no more than the cap are drawn", () => {
  const body = Array.from({ length: 1200 }, (_, i) => [`row ${i}`, i % 2 ? "draft" : "done"]);
  const all = sheetRows(body, "", 500);
  assert.equal(all.rows.length, 500);
  assert.equal(all.total, 1200);
  const found = sheetRows(body, "DONE row 1", 500);
  assert.equal(found.rows[0]!.at, 10, "row 10 is the first done row with 1 in it");
  assert.ok(found.rows.every((r) => body[r.at] === r.cells));
  const dupes = sheetRows([["a"], ["a"], ["a"]], "a", 10);
  assert.deepEqual(dupes.rows.map((r) => r.at), [0, 1, 2], "rows the same each keep their own number");
});

test("the folder is asked one at a time, an older answer never undoes a newer one, the same list stays the same object, and a failure says so", async () => {
  const answers: ((v: Listed) => void)[] = [];
  const fails: ((e: Error) => void)[] = [];
  let asked = 0;
  let heard = 0;
  const poll = workPoller(
    () => (asked++, new Promise<Listed>((ok, no) => (answers.push(ok), fails.push(no)))),
    () => heard++,
  );
  const first = poll.look();
  void poll.look();
  assert.equal(asked, 1, "one asking at a time");
  const second = poll.look(true);
  assert.equal(asked, 2, "unless asked to look again now");
  answers[1]!({ roots: ["/w"], files: [file("b.md")] });
  await second;
  answers[0]!({ roots: ["/w"], files: [file("a.md"), file("b.md")] });
  await first;
  assert.deepEqual(poll.get().files.map((f) => f.path), ["b.md"], "the older answer, with a file since deleted, is dropped");
  assert.equal(heard, 1);
  const kept = poll.get();
  const third = poll.look();
  answers[2]!({ roots: ["/w"], files: [file("b.md")] });
  await third;
  assert.equal(poll.get(), kept, "nothing new: the same object, nothing drawn again");
  assert.equal(heard, 1);
  const fourth = poll.look();
  fails[3]!(new Error("Join this session first."));
  await fourth;
  assert.equal(poll.get().error, "Join this session first.");
  assert.deepEqual(poll.get().files.map((f) => f.path), ["b.md"], "what was listed stays while the error is said");
  const fifth = poll.look();
  answers[4]!({ roots: ["/w"], files: [file("b.md")] });
  await fifth;
  assert.equal(poll.get().error, "", "and goes once the folder answers");
});

test("the web the agents read: Claude in Chrome's pages count, and a page is one page with or without its trailing slash", () => {
  const call = (name: string, args: unknown) => ({ name, arguments: JSON.stringify(args) });
  const events = [
    { ts: 1, lane: "main", actor: { name: "Claude" }, body: { type: "agent.message", text: "", toolCalls: [call("WebFetch", { url: "https://example.com/a/" }), call("mcp__claude-in-chrome__navigate", { url: "https://example.com/a" })] } },
    { ts: 2, lane: "main", actor: { name: "Claude" }, body: { type: "agent.message", text: "", toolCalls: [call("mcp__claude-in-chrome__navigate", { url: "https://news.site/x" }), call("mcp__claude_ai_Gmail__search", { query: "x" })] } },
  ] as never;
  const found = sourcesIn(events, { lanes: [] } as never);
  // In the order they were read, numbered so (Arun, 2026-10-28: "iron everything… focusing on UI and UX").
  assert.deepEqual(found.map((s) => [s.n, s.url]), [[1, "https://example.com/a/"], [2, "https://news.site/x"]]);
});

test("a page's pass is for the one folder it needs, signed apart from invites, for an hour, for its pictures only", () => {
  assert.equal(frameScope("site/index.html", '<img src="hero.png"><img src="img/a.png">'), "site");
  assert.equal(frameScope("site/index.html", '<img src="../shared/a.png">'), "");
  assert.equal(frameScope("a/b/page.html", '<a href="https://x.com"><img src="#x"><video poster="c/p.png">'), "a/b");
  assert.equal(frameDir("/out/site/"), "out/site");
  assert.equal(frameDir("out/../.."), null);
  assert.equal(frameDir(""), "");
  const t = signFrame("s", { sid: "abc", root: 0, dir: "out" }, 1000);
  assert.deepEqual(verifyFrame("s", t, "abc", 1000 + FRAME_TTL_MS - 1), { root: 0, dir: "out" });
  assert.equal(verifyFrame("s", t, "abc", 1000 + FRAME_TTL_MS), null, "an hour, no longer");
  assert.equal(verifyFrame("s", t, "other", 1000), null, "this session's only");
  assert.equal(verifyFrame("other", t, "abc", 1000), null);
  assert.equal(verifyInvite("s", t), null, "never an invite");
  assert.ok(inFrame("out", "out/a.png"));
  assert.ok(inFrame("", "a.mp4"));
  assert.ok(!inFrame("out", "out/../secret.png"));
  assert.ok(!inFrame("out", "outer/a.png"));
  assert.ok(!inFrame("out", "out/notes.md"), "pictures, video and sound only");
  assert.ok(!inFrame("", "/etc/a.png"));
});

test("on this computer, a page's pictures are served by its pass, without the invite, and the pass reads nothing else", async (t) => {
  const was = process.env.FRIDAY_MINE;
  process.env.FRIDAY_MINE = "1";
  const home = await mkdtemp(path.join(tmpdir(), "friday-workframe-"));
  const kv = await localKV(home);
  const app = await createApp({ port: 0, redisUrl: "", prefix: "friday:", secret: "s", driverGraceMs: 15_000, llm: NO_MODELS, dataDir: path.join(home, "uploads"), local: { redis: kv.redis, sub: kv.sub, user: { id: "local", name: "Me" } } });
  t.after(async () => {
    await app.close();
    await kv.close();
    await rm(home, { recursive: true, force: true });
    if (was === undefined) delete process.env.FRIDAY_MINE;
    else process.env.FRIDAY_MINE = was;
  });
  const r0 = await fetch(`${app.url}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", "x-friday-local": "1" }, body: JSON.stringify({ title: "Site", work: true, engine: "claude" }) });
  const { sessionId, invites } = (await r0.json()) as { sessionId: string; invites: Record<string, string> };
  const folder = path.join(home, "work");
  await mkdir(path.join(folder, "site"), { recursive: true });
  await writeFile(path.join(folder, "site", "hero.png"), "png");
  await writeFile(path.join(folder, "site", "notes.md"), "# notes");
  await writeFile(path.join(folder, "other.png"), "png");
  await app.store.append(sessionId, { id: "u", name: "Me", kind: "human" }, { type: "engine.attached", engine: { tool: "claude", cwd: folder, hostId: "local", hostName: "Me" } } as never);
  const inv = encodeURIComponent(invites.owner!);
  const base = `${app.url}/api/sessions/${sessionId}/work`;
  assert.equal((await fetch(`${base}/frame-token?invite=nope&root=0&dir=site`)).status, 403, "a pass only for a member");
  assert.equal((await fetch(`${base}/frame-token?invite=${inv}&root=0&dir=..`)).status, 400);
  assert.equal((await fetch(`${base}/frame-token?invite=${inv}&root=3&dir=site`)).status, 404);
  const { token } = (await (await fetch(`${base}/frame-token?invite=${inv}&root=0&dir=site`)).json()) as { token: string };
  assert.ok(token && !token.includes(invites.owner!));
  const pic = await fetch(`${base}/framed?t=${encodeURIComponent(token)}&path=site/hero.png`);
  assert.equal(pic.status, 200);
  assert.equal(await pic.text(), "png");
  assert.equal((await fetch(`${base}/framed?t=${encodeURIComponent(token)}&path=other.png`)).status, 403, "outside its folder");
  assert.equal((await fetch(`${base}/framed?t=${encodeURIComponent(token)}&path=site/../other.png`)).status, 403);
  assert.equal((await fetch(`${base}/framed?t=${encodeURIComponent(token)}&path=site/notes.md`)).status, 403, "no writing");
  assert.equal((await fetch(`${base}/framed?t=nope&path=site/hero.png`)).status, 403);
  assert.equal((await fetch(`${base}?invite=${encodeURIComponent(token)}`)).status, 403, "and it is no invite");
});

test("the Work home's Right now: one row a session, its most pressing agent's, in plain words", () => {
  // Arun, 2026-10-28: "iron everything and ensure we are good".
  const card = (sid: string, lane: string, column: string, status: string, detail: string, at: number) =>
    ({ id: `${sid}|${lane}`, sid, lane, title: `T ${sid}`, task: `T ${sid}`, agent: lane, tool: "claude", column, status, detail, branch: "", files: 0, pr: null, at, you: true, mine: true }) as never;
  const rows = workRightNow([
    card("a", "main", "ready", "Changes ready", "", 5),
    card("a", "l1", "working", "Working", "Writing the intro", 3),
    card("b", "main", "needs", "Stopped", "Claude Code isn't signed in on the computer it runs on, or its login has expired. Run `claude auth login` in a terminal…", 4),
    card("b", "l1", "ready", "Changes ready", "", 9),
    card("c", "main", "needs", "Stopped", "5-hour limit reached ∙ resets 3pm — that's the limit on the Claude account this machine's Claude Code…", 2),
    card("d", "main", "needs", "Wants to run a command", "rm -rf build", 2),
  ]) as unknown as { sid: string; lane: string; detail: string; task: string }[];
  assert.deepEqual(rows.map((r) => [r.sid, r.lane]), [["a", "l1"], ["b", "main"], ["c", "main"], ["d", "main"]], "one a session, the most pressing");
  assert.deepEqual(rows.slice(1).map((r) => r.detail), ["Isn't signed in on this computer", "Out of usage", "Asks you before it goes on"]);
  assert.ok(rows.every((r) => !/claude auth|`/.test(r.detail)), "no terminal commands");
  assert.equal(rows[1]!.task, "", "the reason, not the task");
});

test("a chat chip reads the piece's title as the rail does, per session, and is told when it changes", () => {
  // Arun, 2026-10-28: "iron everything and ensure we are good": chips kept the file's name once drawn before the rail had read it.
  assert.equal(chipTitle("outputs/friday-video-research.md", "s1"), "Friday video research", "by its name until the folder is read");
  let told = 0;
  const off = titlesChanged(() => told++);
  const before = titlesNow();
  learnTitles([{ path: "outputs/friday-video-research.md", title: "Friday: organic **video** research" }, { path: "README.md", title: "Friday Studio" }], "s1");
  assert.equal(told, 1);
  assert.notEqual(titlesNow(), before);
  assert.equal(chipTitle("outputs/friday-video-research.md", "s1"), "Friday: organic video research");
  assert.equal(chipTitle("./README.md", "s1"), "Friday Studio");
  assert.equal(chipTitle("README.md", "s2"), "README", "another session's README is its own");
  learnTitles([{ path: "README.md", title: "Friday Studio" }, { path: "outputs/friday-video-research.md", title: "Friday: organic **video** research" }], "s1");
  assert.equal(told, 1, "the same titles again change nothing");
  off();
});

test("a chip whose words are the file's own name says that name, not the heading inside it", () => {
  // The 2026-10-28 verify report: a chip for README.md read "Notes", its first heading.
  learnTitles([{ path: "README.md", title: "Notes" }, { path: "outputs/brief.md", title: "The launch brief" }], "s9");
  assert.equal(chipLabel("README.md", "README.md", "s9"), "README.md");
  assert.equal(chipLabel("`readme.md`", "./README.md", "s9"), "README.md", "as the file is named");
  assert.equal(chipLabel("the notes", "README.md", "s9"), "Notes", "other words: its title");
  assert.equal(chipLabel("outputs/brief.md", "outputs/brief.md", "s9"), "The launch brief", "a path: its title");
  assert.equal(chipLabel("brief.md", "outputs/brief.md", "s9"), "brief.md");
});

test("words are counted one way for the rail's card and the reader: no front matter, no code, no bare marks", () => {
  assert.equal(wordCount("---\ntitle: x y z\n---\n# A title\n\n- one two\n- three\n\n```js\nconst a = 1;\n```\n\nCafé 封面 — done."), 9);
  assert.equal(wordCount(""), 0);
  // Chinese and Japanese count a word a character, as word processors do (QA, 2026-10-28: "日本語のメモ" was 2).
  assert.equal(wordCount("日本語のメモ"), 6);
  assert.equal(wordCount("Hello世界 and more"), 5);
});

test("a piece's heading is found one way for the rail, the chips and the reader: # or ##, after front matter", () => {
  assert.equal(headingOf("\n## Notes\n\n- one"), "Notes", "an H2 when it comes first");
  assert.equal(headingOf("---\ntitle: x\n---\nIntro\n# Launch **week**"), "Launch **week**");
  assert.equal(headingOf("No heading here\n### Too deep"), undefined);
});
