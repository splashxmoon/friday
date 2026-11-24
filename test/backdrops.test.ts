import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BackdropStore, GUIDE_MARK, backdropsHttp, readBackdrop, slug, type BackdropsView } from "../src/backdrops.js";

/**
 * Backdrops (backdrops.ts; Arun, 2026-11-20: "app backdrop customization... users can ask their agent or whatever to create a
 * custom UI backdrop for the app"): each a folder of ~/.friday/backdrops, read for what it shows, served walled off from Friday,
 * added to from Settings, put in the trash, and told to the page as it changes.
 */
async function rig() {
  const home = await mkdtemp(path.join(tmpdir(), "friday-backdrops-"));
  const store = new BackdropStore({ root: path.join(home, "backdrops"), trash: path.join(home, "trash", "backdrops"), skills: path.join(home, "skills") });
  await store.start();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    void backdropsHttp(store, req, res, url).then((had) => had || (res.writeHead(404), res.end()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    home,
    store,
    base,
    dir: store.root,
    close: async () => {
      store.close();
      await new Promise((r) => server.close(r));
      await rm(home, { recursive: true, force: true });
    },
  };
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

test("each folder shows what it has: a page first, then a video, then a picture, or what backdrop.json names", async () => {
  const r = await rig();
  try {
    const mk = async (id: string, files: Record<string, string | Buffer>) => {
      await mkdir(path.join(r.dir, id), { recursive: true });
      for (const [f, body] of Object.entries(files)) await writeFile(path.join(r.dir, id, f), body);
    };
    await mk("slow-ocean", { "index.html": "<canvas></canvas>", "still.png": PNG, "backdrop.json": JSON.stringify({ name: "Slow ocean", tone: "dark", dim: 33 }) });
    await mk("rain", { "rain.webm": "x", "poster.jpg": "x" });
    await mk("hills", { "b.png": PNG, "a.jpg": "x" });
    await mk("named", { "a.png": PNG, "b.png": PNG, "backdrop.json": JSON.stringify({ file: "b.png", tone: "beige", dim: 400 }) });
    await mk("empty", {});
    await mk("broken", { "backdrop.json": "{ not json", "a.png": PNG });
    await mk("Bad Name!", { "a.png": PNG });
    await mk(".hidden", { "a.png": PNG });

    const v = await r.store.view();
    const by = Object.fromEntries(v.backdrops.map((b) => [b.id, b]));
    assert.deepEqual(Object.keys(by).sort(), ["hills", "named", "rain", "slow-ocean"]);
    assert.deepEqual({ ...by["slow-ocean"], v: 0 }, { id: "slow-ocean", name: "Slow ocean", kind: "page", file: "index.html", tone: "dark", dim: 33, v: 0 });
    assert.equal(by.rain!.kind, "video");
    assert.equal(by.rain!.name, "Rain", "named after its folder");
    assert.equal(by.hills!.file, "a.jpg", "the first picture by name");
    assert.equal(by.named!.file, "b.png");
    assert.equal(by.named!.tone, undefined, "a tone it doesn't know is left out");
    assert.equal(by.named!.dim, 80, "and a dim kept to 0-80");
    assert.ok(by.hills!.v > 0, "its newest file's time");
    assert.deepEqual(v.unfinished.map((u) => u.id).sort(), ["Bad Name!", "broken", "empty"]);
    assert.match(v.unfinished.find((u) => u.id === "empty")!.why, /No index.html, picture or video/);
    assert.match(v.unfinished.find((u) => u.id === "broken")!.why, /isn't JSON/);
    assert.ok(!v.backdrops.some((b) => b.id === ".hidden") && !v.unfinished.some((u) => u.id === ".hidden"), "a dot folder isn't one");
    // A backdrop.json naming a file that isn't there, or one outside the folder, says so.
    await mk("away", { "backdrop.json": JSON.stringify({ file: "../hills/a.jpg" }) });
    assert.match(((await readBackdrop(r.dir, "away")) as { why: string }).why, /isn't in its folder/);
  } finally {
    await r.close();
  }
});

test("a backdrop's files are served walled off: sandboxed, no network, only its own folder, never a file outside it", async () => {
  const r = await rig();
  try {
    await mkdir(path.join(r.dir, "glow", "js"), { recursive: true });
    await writeFile(path.join(r.dir, "glow", "index.html"), "<script src=js/a.js></script>");
    await writeFile(path.join(r.dir, "glow", "js", "a.js"), "draw()");
    await writeFile(path.join(r.dir, "glow", "loop.mp4"), Buffer.alloc(1000, 7));
    await writeFile(path.join(r.dir, "glow", ".secret"), "no");
    await writeFile(path.join(r.home, "outside.txt"), "no");
    await symlink(path.join(r.home, "outside.txt"), path.join(r.dir, "glow", "link.txt"));

    const page = await fetch(`${r.base}/api/local/backdrops/f/glow/index.html?v=1`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    const csp = page.headers.get("content-security-policy")!;
    assert.match(csp, /^sandbox allow-scripts;/, "a page runs in a sandbox of its own, whatever opens it");
    assert.match(csp, /connect-src 'none'/, "with no network");
    assert.match(csp, new RegExp(`script-src [^;]*${r.base.replace(/[.:/]/g, "\\$&")}/api/local/backdrops/f/glow/`), "its own folder's scripts");
    assert.doesNotMatch(csp, /'self'/, "never all of Friday");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const js = await fetch(`${r.base}/api/local/backdrops/f/glow/js/a.js`);
    assert.equal(await js.text(), "draw()");
    assert.match(js.headers.get("content-security-policy")!, /^sandbox;/, "anything else, sandboxed with no scripts");

    // A range of a video, as a browser asks for one.
    const part = await fetch(`${r.base}/api/local/backdrops/f/glow/loop.mp4`, { headers: { range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
    assert.equal((await part.arrayBuffer()).byteLength, 10);
    assert.equal((await fetch(`${r.base}/api/local/backdrops/f/glow/loop.mp4`, { headers: { range: "bytes=5000-" } })).status, 416);

    for (const bad of ["glow/.secret", "glow/link.txt", "glow/..%2F..%2Foutside.txt", "glow/js", "nope/index.html", "..%2Foutside.txt/x"]) {
      assert.equal((await fetch(`${r.base}/api/local/backdrops/f/${bad}`)).status, 404, bad);
    }
  } finally {
    await r.close();
  }
});

test("a picture added becomes a backdrop of its own, named after it; one taken out goes to Friday's trash", async () => {
  const r = await rig();
  try {
    const add = (name: string, type: string, body: Uint8Array | string) => fetch(`${r.base}/api/local/backdrops?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : new Blob([new Uint8Array(body)]) });
    const a = await add("My Hills.png", "image/png", PNG);
    assert.equal(a.status, 200);
    const got = (await a.json()) as BackdropsView & { backdrop: { id: string; name: string; kind: string; file: string } };
    assert.deepEqual([got.backdrop.id, got.backdrop.name, got.backdrop.kind, got.backdrop.file], ["my-hills", "My Hills", "image", "backdrop.png"]);
    assert.ok(got.backdrops.some((b) => b.id === "my-hills"));
    const again = (await (await add("My Hills.png", "image/png", PNG)).json()) as { backdrop: { id: string } };
    assert.equal(again.backdrop.id, "my-hills-2", "a second of the same name beside it");
    assert.equal((await add("x.html", "text/html", "<script>")).status, 415, "only a picture or a video");
    assert.equal((await add("x.png", "image/png", "")).status, 400);

    const del = await fetch(`${r.base}/api/local/backdrops/my-hills`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.ok(!((await del.json()) as BackdropsView).backdrops.some((b) => b.id === "my-hills"));
    const trashed = await readdir(path.join(r.home, "trash", "backdrops"));
    assert.equal(trashed.length, 1);
    assert.match(trashed[0]!, /^my-hills-\d+$/);
    assert.equal((await fetch(`${r.base}/api/local/backdrops/my-hills`, { method: "DELETE" })).status, 404);
    assert.equal((await fetch(`${r.base}/api/local/backdrops/..`, { method: "DELETE" })).status, 404);
    assert.equal(slug("  Rain, on glass! "), "rain-on-glass");
    assert.equal(slug("☂"), "backdrop");
  } finally {
    await r.close();
  }
});

test("the folder says how to make one, to any agent: AGENTS.md there and a skill in the shared library, kept current unless made your own", async () => {
  const r = await rig();
  try {
    const guide = await readFile(path.join(r.dir, "AGENTS.md"), "utf8");
    assert.ok(guide.startsWith(GUIDE_MARK));
    assert.ok(guide.includes(r.dir), "it names the folder");
    for (const rule of ["index.html", "backdrop.json", "still=1", "prefers-reduced-motion", "no network"]) assert.ok(guide.includes(rule), rule);
    const skill = await readFile(path.join(r.home, "skills", "friday-backdrop", "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: friday-backdrop\ndescription: .+backdrop/);
    assert.ok(skill.includes(r.dir));
    // Made your own (the first line taken out): left as it is.
    await writeFile(path.join(r.dir, "AGENTS.md"), "# mine\n");
    await r.store.ensure();
    assert.equal(await readFile(path.join(r.dir, "AGENTS.md"), "utf8"), "# mine\n");
  } finally {
    await r.close();
  }
});

test("the page is told when the folder changes", async () => {
  const r = await rig();
  try {
    const told = new Promise<number>((resolve) => r.store.onChange(resolve));
    await mkdir(path.join(r.dir, "new-one"));
    await writeFile(path.join(r.dir, "new-one", "a.png"), PNG);
    const v = await Promise.race([told, new Promise<number>((_, no) => setTimeout(() => no(new Error("never told")), 5000))]);
    assert.ok(v > 0);
  } finally {
    await r.close();
  }
});
