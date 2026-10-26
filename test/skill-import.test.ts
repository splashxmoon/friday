import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { discoverSkills, parseRepo, parseSkillFile, readSkills, readTar, type Fetcher } from "../src/skill-import.js";

/** A repository held in memory: the tree call, and the raw file calls. */
function fakeGithub(files: Record<string, string>, opts: { status?: number } = {}): Fetcher {
  return async (url) => {
    const reply = (status: number, body: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => String(body),
      json: async () => body,
      headers: { get: () => null },
    });
    if (url.startsWith("https://api.github.com/")) {
      if (opts.status) return reply(opts.status, {});
      return reply(200, { tree: Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: text.length })), truncated: false });
    }
    const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
    const path = m ? m[1]!.split("/").map(decodeURIComponent).join("/") : "";
    return path in files ? reply(200, files[path]) : reply(404, "");
  };
}

test("addresses: the forms people paste all resolve to the same repository", () => {
  assert.deepEqual(parseRepo("https://github.com/alirezarezvani/claude-skills"), { owner: "alirezarezvani", repo: "claude-skills", ref: "HEAD", path: "" });
  assert.deepEqual(parseRepo("github.com/a/b.git"), { owner: "a", repo: "b", ref: "HEAD", path: "" });
  assert.deepEqual(parseRepo("a/b"), { owner: "a", repo: "b", ref: "HEAD", path: "" });
  assert.deepEqual(parseRepo("https://github.com/a/b/tree/main/engineering/tdd"), { owner: "a", repo: "b", ref: "main", path: "engineering/tdd" });
  assert.equal(parseRepo("https://github.com/a/b/blob/main/x/y/SKILL.md").path, "x/y", "a file address means the folder it is in");
  assert.throws(() => parseRepo("https://example.com/a/b"), /GitHub/);
  assert.throws(() => parseRepo("not a repo"), /GitHub/);
});

test("front matter: plain, quoted, folded and missing", () => {
  const a = parseSkillFile('---\nname: pdf-tools\ndescription: "Work with PDFs"\n---\n# Body\nText');
  assert.deepEqual(a.meta, { name: "pdf-tools", description: "Work with PDFs" });
  assert.equal(a.body, "# Body\nText");
  const b = parseSkillFile("---\nname: x\ndescription: >\n  first line\n  second line\nother: y\n---\nBody");
  assert.equal(b.meta.description, "first line second line");
  assert.equal(b.meta.other, "y");
  assert.deepEqual(parseSkillFile("Just text").meta, {});
  assert.equal(parseSkillFile("﻿---\r\nname: crlf\r\n---\r\nBody").meta.name, "crlf");
});

const repo = {
  "README.md": "readme",
  "eng/tdd/SKILL.md": "---\nname: test-driven-development\ndescription: Write the failing test first.\n---\nRed, green, refactor.",
  "eng/tdd/references/patterns.md": "pattern notes",
  "eng/tdd/scripts/run.py": "print(1)",
  "eng/tdd/LICENSE": "mit",
  "ops/incident/SKILL.md": "---\nname: incident\n---\n" + "Step.\n\n".repeat(2000),
  "notes/other.md": "not a skill",
};

test("discovery lists skills with the name and description each gives itself", async () => {
  const r = await discoverSkills(fakeGithub(repo), "a/b");
  assert.deepEqual(r.skills.map((s) => s.path), ["eng/tdd/SKILL.md", "ops/incident/SKILL.md"]);
  assert.equal(r.skills[0]!.name, "Test driven development");
  assert.equal(r.skills[0]!.description, "Write the failing test first.");
  assert.equal(r.skills[1]!.description, "");
});

test("discovery under a folder only lists that folder", async () => {
  const r = await discoverSkills(fakeGithub(repo), "https://github.com/a/b/tree/main/ops");
  assert.deepEqual(r.skills.map((s) => s.path), ["ops/incident/SKILL.md"]);
});

test("a repository with no skills says what a skill is", async () => {
  await assert.rejects(discoverSkills(fakeGithub({ "a.md": "x" }), "a/b"), /SKILL\.md/);
});

test("GitHub's answers become sentences", async () => {
  await assert.rejects(discoverSkills(fakeGithub(repo, { status: 404 }), "a/b"), /private|wrong/);
  await assert.rejects(discoverSkills(fakeGithub(repo, { status: 403 }), "a/b"), /busy right now/);
});

test("reading: references come along, scripts and licences do not, and the source is recorded", async () => {
  const { skills } = await readSkills(fakeGithub(repo), "a/b", ["eng/tdd/SKILL.md"]);
  assert.equal(skills.length, 1);
  const s = skills[0]!;
  assert.equal(s.name, "Test driven development");
  assert.equal(s.instructions, "Red, green, refactor.");
  assert.deepEqual(s.resources, [{ name: "references/patterns.md", text: "pattern notes" }]);
  assert.deepEqual(s.source, { repo: "a/b", path: "eng/tdd/SKILL.md" });
  assert.equal(s.leftBehind, 2, "the script and the licence");
});

test("a long skill is split so nothing is cut: the overflow becomes a reference", async () => {
  const { skills } = await readSkills(fakeGithub(repo), "a/b", ["ops/incident/SKILL.md"]);
  const s = skills[0]!;
  assert.ok(s.instructions!.length <= 8000);
  assert.match(s.instructions!, /continues in the reference/);
  const rest = s.resources!.find((r) => r.name === "Continued")!;
  assert.ok(rest.text.length > 1000);
});

test("only SKILL.md paths are read, and a missing one is reported rather than invented", async () => {
  const r = await readSkills(fakeGithub(repo), "a/b", ["eng/tdd/SKILL.md", "ghost/SKILL.md", "notes/other.md"]);
  assert.equal(r.skills.length, 1);
  assert.deepEqual(r.skipped, ["ghost/SKILL.md"]);
  await assert.rejects(readSkills(fakeGithub(repo), "a/b", ["notes/other.md"]), /at least one/);
});

test("looking and then importing costs one GitHub call, not two", async () => {
  let api = 0;
  const base = fakeGithub(repo);
  const counting: Fetcher = async (url, init) => {
    if (url.startsWith("https://api.github.com/")) api++;
    return base(url, init);
  };
  await discoverSkills(counting, "a/b");
  await readSkills(counting, "a/b", ["eng/tdd/SKILL.md"]);
  await discoverSkills(counting, "a/b");
  assert.equal(api, 1);
});

test("the rate-limit message is plain, with nothing for the person to configure", async () => {
  const limited: Fetcher = async () => ({ ok: false, status: 403, text: async () => "", json: async () => ({}), headers: { get: () => null } });
  await assert.rejects(discoverSkills(limited, "a/b"), (e: Error) => /busy right now/.test(e.message) && !/GITHUB_TOKEN/.test(e.message));
});

/** A tar archive, built by hand: a 512-byte header per file, the body padded to 512. */
function tar(files: Record<string, string>, opts: { pax?: boolean } = {}): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type = "0") => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(type, 156);
    h.write("ustar\0", 257);
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    if (opts.pax) {
      const rec = ` path=${name}\n`;
      const line = Buffer.from(`${String(rec.length + String(rec.length).length)}${rec}`);
      blocks.push(header("pax", line.length, "x"), pad(line));
    }
    blocks.push(header(opts.pax ? "short" : name, body.length), pad(body));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test("an archive is read: the top folder is dropped, text is kept, long pax paths work", () => {
  const files = { "repo-abc/eng/tdd/SKILL.md": "hello", "repo-abc/eng/tdd/image.png": "binary", "repo-abc/README.md": "r" };
  const snap = readTar(tar(files), (p) => /\.md$/.test(p));
  assert.deepEqual([...snap.files.keys()].sort(), ["README.md", "eng/tdd/SKILL.md", "eng/tdd/image.png"]);
  assert.equal(snap.files.get("eng/tdd/SKILL.md")!.text, "hello");
  assert.equal(snap.files.get("eng/tdd/image.png")!.text, undefined, "not kept as text, but counted");
  const long = "repo-abc/" + "deep/".repeat(30) + "SKILL.md";
  const viaPax = readTar(tar({ [long]: "x" }, { pax: true }), () => true);
  assert.ok(viaPax.files.has("deep/".repeat(30) + "SKILL.md"), "a path longer than a tar header holds survives");
});

test("one download is the whole import: no API call, no per-file requests", async () => {
  const archive = gzipSync(
    tar({
      "b-sha/eng/tdd/SKILL.md": "---\nname: tdd\ndescription: Test first.\n---\nRed, green, refactor.",
      "b-sha/eng/tdd/references/patterns.md": "pattern notes",
      "b-sha/ops/incident/SKILL.md": "---\nname: incident\n---\nPage the owner.",
    }),
  );
  const urls: string[] = [];
  const f: Fetcher = async (url) => {
    urls.push(url);
    if (url.startsWith("https://codeload.github.com/a/b/tar.gz/")) {
      return { ok: true, status: 200, text: async () => "", json: async () => ({}), arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer, headers: { get: () => null } };
    }
    throw new Error("unexpected request " + url);
  };
  const found = await discoverSkills(f, "a/b");
  assert.deepEqual(found.skills.map((x) => [x.path, x.description]), [["eng/tdd/SKILL.md", "Test first."], ["ops/incident/SKILL.md", ""]]);
  const { skills } = await readSkills(f, "a/b", ["eng/tdd/SKILL.md"]);
  assert.equal(skills[0]!.instructions, "Red, green, refactor.");
  assert.deepEqual(skills[0]!.resources, [{ name: "references/patterns.md", text: "pattern notes" }]);
  assert.equal(urls.length, 1, "a single request, to the archive");
});

test("when the archive can't be had, the API path still works", async () => {
  const base = fakeGithub(repo);
  const noArchive: Fetcher = async (url, init) => (url.startsWith("https://codeload.github.com/") ? { ok: false, status: 404, text: async () => "", json: async () => ({}), headers: { get: () => null } } : base(url, init));
  const r = await discoverSkills(noArchive, "a/b");
  assert.equal(r.skills.length, 2);
});
