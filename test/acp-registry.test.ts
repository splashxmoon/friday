// "Other ACP agent" picked from the ACP registry (runner/acp-registry.ts): a stand-in registry and download, the download
// checked against its SHA-256 before anything in it runs, unpacked into Friday's own folder, and its command said.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { binOf, howFor, installFromRegistry, platformKey, type RegistryAgent } from "../src/runner/acp-registry.js";

test("the platform as the registry names it, and how an agent comes to it", () => {
  assert.equal(platformKey("darwin", "arm64"), "darwin-aarch64");
  assert.equal(platformKey("win32", "x64"), "windows-x86_64");
  assert.equal(platformKey("linux", "arm64"), "linux-aarch64");
  const both: RegistryAgent = { id: "kilo", name: "Kilo", version: "7.8.27", distribution: { npx: { package: "@kilocode/cli@7.8.27" }, binary: { "darwin-aarch64": { archive: "https://x/k.zip", cmd: "./kilo" } } } };
  assert.equal(howFor(both, "darwin-aarch64"), "download", "a download first: no Node needed");
  assert.equal(howFor(both, "windows-x86_64"), "npm");
  assert.equal(howFor({ id: "f", name: "f", version: "1", distribution: { uvx: { package: "fast-agent-acp" } } }), "uvx");
  assert.equal(howFor({ id: "n", name: "n", version: "1", distribution: {} }), null);
  assert.equal(binOf({ name: "@qwen-code/qwen-code", bin: { qwen: "cli.js" } }), "cli.js");
  assert.equal(binOf({ name: "@scope/goose", bin: { a: "a.js", goose: "g.js" } }), "g.js");
  assert.equal(binOf({ name: "x", bin: "bin/x.js" }), "bin/x.js");
  assert.equal(binOf({ name: "x" }), null);
});

async function rig(o: { sha?: "right" | "wrong" | "none"; url?: string } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "friday-reg-test-"));
  const src = path.join(dir, "src");
  await mkdir(src);
  await writeFile(path.join(src, "goose"), "#!/bin/sh\necho stand-in goose\n");
  const archive = path.join(dir, "goose.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", src, "goose"]);
  const bytes = await readFile(archive);
  const sha = o.sha === "wrong" ? "0".repeat(64) : o.sha === "none" ? undefined : createHash("sha256").update(bytes).digest("hex");
  const key = platformKey();
  const registry = { version: "1", agents: [{ id: "goose", name: "goose", version: "1.58.1", description: "A local agent", distribution: { binary: { [key]: { archive: o.url ?? "https://example.test/goose.tar.gz", cmd: "./goose", args: ["acp"], ...(sha ? { sha256: sha } : {}) } } } }] };
  const fetched: string[] = [];
  const fetchImpl = (async (u: string | URL) => {
    fetched.push(String(u));
    if (String(u).endsWith("registry.json")) return new Response(JSON.stringify(registry), { status: 200 });
    return new Response(bytes, { status: 200 });
  }) as typeof fetch;
  return { dir, root: path.join(dir, "agents"), fetchImpl, fetched, key };
}

test("a download is checked against its SHA-256, unpacked into Friday's own folder, and its command said", async () => {
  if (process.platform === "win32") return; // the stand-in is a shell script
  const r = await rig();
  try {
    const got = await installFromRegistry("goose", { fetchImpl: r.fetchImpl, root: r.root, key: r.key });
    const cmd = path.join(r.root, "goose", "1.58.1", "goose");
    assert.deepEqual({ command: got.command, args: got.args, name: got.name, version: got.version }, { command: cmd, args: ["acp"], name: "goose", version: "1.58.1" });
    assert.equal(execFileSync(cmd).toString().trim(), "stand-in goose", "unpacked and runnable");
    assert.ok(!existsSync(path.join(r.root, "goose", "1.58.1", "goose.tar.gz")), "the archive is not kept");
    // Again: already there, nothing downloaded.
    const n = r.fetched.length;
    await installFromRegistry("goose", { fetchImpl: r.fetchImpl, root: r.root, key: r.key });
    assert.equal(r.fetched.filter((u) => !u.endsWith("registry.json")).length, r.fetched.slice(0, n).filter((u) => !u.endsWith("registry.json")).length);
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});

test("a download that doesn't match, has no checksum, or isn't https is never run", async () => {
  for (const [o, said] of [
    [{ sha: "wrong" }, /didn't match the registry's checksum/],
    [{ sha: "none" }, /no checksum/],
    [{ url: "http://example.test/goose.tar.gz" }, /isn't https/],
  ] as const) {
    const r = await rig(o);
    try {
      await assert.rejects(installFromRegistry("goose", { fetchImpl: r.fetchImpl, root: r.root, key: r.key }), said);
      assert.ok(!existsSync(path.join(r.root, "goose", "1.58.1", "goose")), "nothing in place to run");
    } finally {
      await rm(r.dir, { recursive: true, force: true });
    }
  }
  const r = await rig();
  try {
    await assert.rejects(installFromRegistry("../etc", { fetchImpl: r.fetchImpl, root: r.root }), /isn't an agent in the ACP registry/);
    await assert.rejects(installFromRegistry("nobody", { fetchImpl: r.fetchImpl, root: r.root }), /isn't in the ACP registry any more/);
  } finally {
    await rm(r.dir, { recursive: true, force: true });
  }
});
