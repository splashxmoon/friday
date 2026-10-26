import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { claudePictures } from "../src/runner/adapters.js";
import { WarmClaude } from "../src/runner/spawn-cli.js";

// Pictures attached in Friday reach Claude Code as pictures, as one pasted at its own prompt does (Arun, 2026-10-25: "allow
// for screenshots and images to be read and viewed by the coding tools like how claude does it here").

/** A Claude Code that says back what each message it was handed held: its words and the kinds of its blocks. */
const FAKE = `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
out({ type: "system", subtype: "init", session_id: "s1" });
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type !== "user") return;
  const c = m.message.content;
  const said = typeof c === "string" ? "text:" + c : c.map((b) => b.type === "image" ? "image:" + b.source.media_type + ":" + b.source.data : "text:" + b.text).join("|");
  out({ type: "result", subtype: "success", result: said, session_id: "s1" });
});
`;

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-pics-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "fake-claude.mjs");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  const png = path.join(dir, "shot.png");
  await writeFile(png, Buffer.from("not really a png"));
  const big = path.join(dir, "huge.jpg");
  await writeFile(big, Buffer.alloc(4 * 1024 * 1024));
  const notes = path.join(dir, "notes.txt");
  await writeFile(notes, "words");
  return { dir, bin, png, big, notes };
}

test("only pictures, small enough for the API, become image blocks", async (t) => {
  const { png, big, notes, dir } = await setup(t);
  const blocks = claudePictures({ files: [png, big, notes, path.join(dir, "gone.png")] } as never);
  assert.deepEqual(blocks, [{ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("not really a png").toString("base64") } }]);
});

test("the kept Claude Code is handed a turn's pictures beside its words", { skip: process.platform === "win32" }, async (t) => {
  const { bin, png } = await setup(t);
  const warm = new WarmClaude();
  t.after(() => warm.close());
  const run = async (prompt: string, pictures: Record<string, unknown>[]) => {
    const child = warm.start(process.execPath, [bin, "-p"], {}, pictures);
    const lines: string[] = [];
    child.stdout!.on("data", (d: Buffer) => lines.push(...String(d).split("\n").filter(Boolean)));
    child.stdin!.end(prompt);
    await new Promise<void>((r) => child.once("exit", () => r()));
    return lines.map((l) => JSON.parse(l)).find((m) => m.type === "result")?.result as string;
  };
  assert.equal(await run("hello", []), "text:hello", "no pictures: the words alone, as before");
  const data = Buffer.from("not really a png").toString("base64");
  assert.equal(await run("what's wrong here?", claudePictures({ files: [png] } as never)), `text:what's wrong here?|image:image/png:${data}`);
});
