import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { FileStore, isUsableFile, resolveAttachments, safeName } from "../src/files.js";
import { blobStore, s3ForTest } from "../src/blobs.js";

/**
 * Attaching files, and attaching a folder.
 *
 * The rule that matters is that the picker and the server agree with what the
 * model actually receives: anything accepted has to arrive as text, an image or
 * a PDF, never as "binary content not shown".
 */

let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "friday-uploads-"));
});
after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

test("what is accepted is exactly what the agent can read", () => {
  for (const [name, type] of [
    ["notes.md", "text/markdown"],
    ["app.ts", ""],
    ["data.csv", "text/csv"],
    ["diagram.png", "image/png"],
    ["contract.pdf", "application/pdf"],
    ["Dockerfile.txt", "text/plain"],
  ] as const) {
    assert.ok(isUsableFile(name, type), `${name} should be accepted`);
  }
  for (const [name, type] of [
    ["archive.zip", "application/zip"],
    ["clip.mp4", "video/mp4"],
    ["design.sketch", "application/octet-stream"],
    ["font.woff2", "font/woff2"],
    ["photo.heic", "image/heic"],
  ] as const) {
    assert.ok(!isUsableFile(name, type), `${name} should be refused`);
  }
});

test("a folder upload keeps the path, and cannot escape with it", () => {
  assert.equal(safeName("src/agent/tools.ts"), "src/agent/tools.ts");
  assert.equal(safeName("src\\agent\\tools.ts"), "src/agent/tools.ts", "a Windows folder still reads as a path");
  assert.equal(safeName("../../etc/passwd"), "etc/passwd");
  assert.equal(safeName("/etc/passwd"), "etc/passwd");
  assert.equal(safeName("C:\\Users\\Ada\\notes.md"), "Users/Ada/notes.md");
  assert.equal(safeName("./a/./b.txt"), "a/b.txt");
  assert.equal(safeName(""), "file");
  assert.equal(safeName("../.."), "file");
});

test("an uploaded file comes back as model input under its folder path", async () => {
  const store = new FileStore(dir);
  const saved = await store.save("sess1", {
    name: "src/agent/tools.ts",
    type: "text/plain",
    data: Buffer.from("export const answer = 42;\n"),
    uploadedBy: "u1",
  });
  assert.equal(saved.name, "src/agent/tools.ts");

  const resolved = await resolveAttachments(store, "sess1", [saved]);
  const f = resolved.get(saved.id)!;
  assert.equal(f.kind, "text", "a .ts file has to reach the model as text, not as bytes");
  assert.match(f.kind === "text" ? f.text : "", /answer = 42/);
});

test("files are addressed per session, so another session can't read them", async () => {
  const store = new FileStore(dir);
  const saved = await store.save("sess-a", { name: "secret.md", type: "text/markdown", data: Buffer.from("private"), uploadedBy: "u1" });
  assert.ok(await store.get("sess-a", saved.id));
  assert.equal(await store.get("sess-b", saved.id), null);
});

test("object storage is used when configured, disk when not, and never half-configured", () => {
  assert.equal(blobStore(dir, {} as NodeJS.ProcessEnv).kind, "disk");
  assert.equal(
    blobStore(dir, { S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" } as NodeJS.ProcessEnv).kind,
    "s3",
  );
  // Half-configured is the dangerous one: it would write to a disk the host
  // is about to throw away, silently.
  assert.throws(() => blobStore(dir, { S3_BUCKET: "b" } as NodeJS.ProcessEnv), /half-configured/);
  assert.throws(() => blobStore(dir, { S3_ENDPOINT: "https://x.r2.cloudflarestorage.com" } as NodeJS.ProcessEnv), /half-configured/);
});

test("the S3 request is signed the way AWS documents", async () => {
  // AWS's documented example credentials, asserting the shape of what goes on
  // the wire: the canonical URI, which headers are signed, and that the
  // payload hash is the body's. Those are the parts that rot silently and
  // come back as a 403 nobody can read.
  const store = s3ForTest({
    bucket: "examplebucket",
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    endpoint: "https://s3.amazonaws.com",
  });
  let seen: { url: string; headers: Record<string, string> } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) };
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    await store.put("a folder/notes.md", Buffer.from("hello"), "text/markdown");
  } finally {
    globalThis.fetch = realFetch;
  }
  const sent = seen! as { url: string; headers: Record<string, string> };
  assert.equal(sent.url, "https://s3.amazonaws.com/examplebucket/a%20folder/notes.md", "path-style, each segment escaped, slashes kept");
  assert.match(sent.headers.Authorization!, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/);
  assert.match(sent.headers.Authorization!, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date/);
  assert.match(sent.headers.Authorization!, /Signature=[0-9a-f]{64}$/);
  // The payload hash is the body's, which is what makes the signature mean anything.
  assert.equal(sent.headers["x-amz-content-sha256"], createHash("sha256").update("hello").digest("hex"));
});

/**
 * Picking a folder.
 *
 * A folder arrives as every file inside it, and three things have to be true
 * before that is useful: the noise is gone, each file remembers which folder it
 * came from (so the composer can show one chip instead of two hundred), and
 * what didn't fit is counted rather than dropped in silence.
 */
test("a picked folder keeps its files, its origin, and an honest count of what was left", async () => {
  const { pickable, MAX_FILES, MAX_ONE_IN_FOLDER } = await import("../src/client/Attach.js");
  // The size is claimed rather than allocated: a test of a gigabyte ceiling shouldn't need a gigabyte.
  const file = (p: string, size = 400) => {
    const f = new File(["x"], p.split("/").pop()!, { type: "" });
    Object.defineProperty(f, "webkitRelativePath", { value: p });
    Object.defineProperty(f, "size", { value: size });
    return f;
  };

  const picked = pickable([
    file("my-app/src/index.ts"),
    file("my-app/README.md"),
    file("my-app/node_modules/left-pad/index.js"),
    file("my-app/.git/HEAD"),
    file("my-app/dist/bundle.js"),
    file("my-app/logo.psd"),
  ]);
  assert.deepEqual(
    picked.keep.map((k) => k.path),
    // Inside a folder everything goes: a working copy with the pictures missing does not run.
    ["my-app/src/index.ts", "my-app/README.md", "my-app/logo.psd"],
  );
  assert.ok(
    picked.keep.every((k) => k.folder === "my-app"),
    "every file knows the folder it was picked as part of",
  );
  assert.equal(picked.skipped, 3);
  assert.match(picked.reason, /build and dependency folders/);
  assert.doesNotMatch(picked.reason, /media and binaries/, "nothing inside a folder is dropped for being media");
  assert.equal(picked.over, 0);

  // A file picked on its own has no folder, so it stays its own chip.
  const one = pickable([new File(["hi"], "notes.md", { type: "text/markdown" })]);
  assert.equal(one.keep[0]!.folder, undefined);

  // A source tree of a few hundred files goes up whole, rather than being
  // silently halved at a round number.
  const big = pickable(Array.from({ length: 500 }, (_, i) => file(`repo/src/mod-${i}.ts`)));
  assert.equal(big.keep.length, 500);
  assert.equal(big.over, 0);

  // Past the ceiling, the remainder is counted — that is what the composer says
  // out loud instead of pretending the whole folder went.
  const huge = pickable(Array.from({ length: MAX_FILES + 100 }, (_, i) => file(`repo/src/mod-${i}.ts`, 10)));
  assert.equal(huge.keep.length, MAX_FILES);
  assert.equal(huge.over, 100);

  // And bytes stop it before the file count does when the files are large.
  const heavy = pickable(Array.from({ length: 12 }, (_, i) => file(`media/doc-${i}.md`, 150 * 1024 * 1024)));
  assert.ok(heavy.keep.length < 12 && heavy.keep.length >= 5, `stopped on the byte budget, kept ${heavy.keep.length}`);
  assert.equal(heavy.over, 12 - heavy.keep.length);

  // A single file past what the server will take is dropped here and said,
  // rather than carried all the way to a failed upload.
  const oversize = pickable([file("repo/video.md", MAX_ONE_IN_FOLDER + 1), file("repo/ok.md")]);
  assert.deepEqual(
    oversize.keep.map((k) => k.path),
    ["repo/ok.md"],
  );
  assert.equal(oversize.skipped, 1);
  assert.match(oversize.reason, /too large/);
});

/**
 * The room left counts what is already on the composer.
 *
 * Attaching a big folder and then two files by hand used to lose the two
 * files: the cap was applied to the merged list, so the newest picks fell off
 * the end without a word.
 */
test("a second pick is measured against what is already attached, and says what didn't fit", async () => {
  const { pickable, attach, MAX_FILES } = await import("../src/client/Attach.js");
  const file = (p: string) => {
    const f = new File(["x".repeat(200)], p.split("/").pop()!, { type: "text/plain" });
    Object.defineProperty(f, "webkitRelativePath", { value: p });
    return f;
  };

  const folder = pickable(Array.from({ length: MAX_FILES }, (_, i) => file(`repo/src/mod-${i}.ts`)));
  assert.equal(folder.keep.length, MAX_FILES);

  // Full: two more files have nowhere to go, and that is said rather than done.
  const after = pickable([new File(["hi"], "notes.md", { type: "text/markdown" })], folder.keep);
  assert.equal(after.keep.length, 0);
  assert.equal(after.over, 1);

  let held = folder.keep;
  let note = "";
  attach(
    held,
    [new File(["hi"], "notes.md", { type: "text/markdown" })],
    (f) => (held = f),
    (m) => (note = m),
  );
  assert.equal(held.length, MAX_FILES, "nothing was quietly swapped out to fit it");
  assert.match(note, /no room left/i);

  // With room, a later pick lands alongside the folder and keeps its own chip.
  let some = pickable(Array.from({ length: 3 }, (_, i) => file(`repo/src/mod-${i}.ts`))).keep;
  attach(
    some,
    [new File(["hi"], "notes.md", { type: "text/markdown" })],
    (f) => (some = f),
    () => {},
  );
  assert.equal(some.length, 4);
  assert.equal(some[3]!.folder, undefined);
  assert.equal(some.filter((f) => f.folder === "repo").length, 3);
});
