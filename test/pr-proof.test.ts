import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROOF_END, PROOF_START, proofBlock, proofPath, rawUrl, withProofBlock } from "../src/proof-block.js";
import { prProof, pushProof } from "../src/runner/pr-proof.js";

// Proof clips in pull requests (Arun, 2026-11-21: "add clips to PRs and the phone too also see where else we can intergrate it"): the
// description's block, put in again in place or added; and the GIFs kept on friday-proof against a real (local, bare) remote, without
// touching the folder, never over somebody else's history.

const block = proofBlock({ page: "/checkout", after: "https://x/a.gif", before: "https://x/b.gif", marks: [{ atMs: 2431, label: "New: “Pay now”" }, { atMs: 5200, label: "Clicked “Pay now”" }] });

test("the block: a heading, the walk inline, before and after side by side, the steps, and who recorded it", () => {
  assert.ok(block.startsWith(PROOF_START) && block.endsWith(PROOF_END));
  assert.match(block, /### Proof\n\n!\[\/checkout, walked through what changed\]\(https:\/\/x\/a\.gif\)/);
  assert.match(block, /\| Before \| After \|\n\| --- \| --- \|\n\| !\[\/checkout before the change\]\(https:\/\/x\/b\.gif\) \| !\[\/checkout after the change\]\(https:\/\/x\/a\.gif\) \|/);
  assert.match(block, /- 2\.4s · New: “Pay now”\n- 5\.2s · Clicked “Pay now”/);
  assert.match(block, /Recorded by Friday when the work finished/);
  const lone = proofBlock({ page: "/", after: "https://x/a.gif" });
  assert.ok(!lone.includes("| Before |"), "no table without a before clip");
  assert.ok(!proofBlock({ page: "/a]|b", after: "u" }).includes("a]|b"), "a page can't break its alt text or the table");
});

test("the block goes in once: replaced in place, else added at the end, what a person wrote around it kept", () => {
  assert.equal(withProofBlock("", block), `${block}\n`);
  const written = "## Why\nFix the checkout.\n\n";
  const once = withProofBlock(written, block);
  assert.equal(once, `## Why\nFix the checkout.\n\n${block}\n`);
  const around = `${once}\n## Notes\nPlease look at the totals.`;
  const newer = proofBlock({ page: "/checkout", after: "https://x/c.gif" });
  const twice = withProofBlock(around, newer);
  assert.equal(twice.split(PROOF_START).length, 2, "still one block");
  assert.ok(twice.includes("https://x/c.gif") && !twice.includes("https://x/a.gif"));
  assert.ok(twice.startsWith("## Why\nFix the checkout.") && twice.endsWith("## Notes\nPlease look at the totals."));
});

test("where a GIF is kept, and its raw address", () => {
  assert.equal(proofPath(42, "/checkout/pay", "1a2b3c"), "pr-42/checkout-pay-1a2b3c.gif");
  assert.equal(proofPath(42, "/", "1a2b3c", "before"), "pr-42/home-before-1a2b3c.gif");
  assert.equal(rawUrl("acme", "web", "abc123", "pr-42/home-1a2b3c.gif"), "https://github.com/acme/web/blob/abc123/pr-42/home-1a2b3c.gif?raw=true");
});

const GIF = (n: number) => Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16, n), Buffer.from([0x3b])]);
const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd }).toString().trim();

function remoteAndClone(): { remote: string; clone: string; other: string; done: () => void } {
  const top = mkdtempSync(path.join(os.tmpdir(), "friday-proof-test-"));
  const remote = path.join(top, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const clone = path.join(top, "work");
  execFileSync("git", ["clone", "-q", remote, clone]);
  writeFileSync(path.join(clone, "app.txt"), "v1\n");
  g(clone, "add", ".");
  g(clone, "commit", "-qm", "init");
  g(clone, "push", "-q", "origin", "HEAD:main");
  const other = path.join(top, "other");
  execFileSync("git", ["clone", "-q", remote, other]);
  return { remote, clone, other, done: () => rmSync(top, { recursive: true, force: true }) };
}

test("GIFs onto friday-proof: a first commit with a README, a second on top keeping the first, the folder untouched", async () => {
  const r = remoteAndClone();
  try {
    writeFileSync(path.join(r.clone, "app.txt"), "v2, not committed\n");
    const head = g(r.clone, "rev-parse", "HEAD");
    const branch = g(r.clone, "rev-parse", "--abbrev-ref", "HEAD");
    const first = await pushProof(r.clone, [{ path: "pr-7/home-aaa.gif", data: GIF(1) }], "Proof for #7: /");
    assert.equal(g(r.remote, "rev-parse", "friday-proof"), first.commit);
    assert.equal(g(r.remote, "log", "--format=%P", "-1", "friday-proof"), "", "its own history: no parent, nothing of main's");
    assert.deepEqual(g(r.remote, "ls-tree", "-r", "--name-only", "friday-proof").split("\n").sort(), ["README.md", "pr-7/home-aaa.gif"]);
    const second = await pushProof(r.clone, [{ path: "pr-7/home-bbb.gif", data: GIF(2) }, { path: "pr-8/cart-ccc.gif", data: GIF(3) }], "Proof for #7 and #8");
    assert.equal(g(r.remote, "rev-parse", "friday-proof^"), first.commit, "on top of the first");
    assert.deepEqual(g(r.remote, "ls-tree", "-r", "--name-only", "friday-proof").split("\n").sort(), ["README.md", "pr-7/home-aaa.gif", "pr-7/home-bbb.gif", "pr-8/cart-ccc.gif"]);
    assert.deepEqual(execFileSync("git", ["cat-file", "blob", `${second.commit}:pr-8/cart-ccc.gif`], { cwd: r.clone }), GIF(3), "the bytes as given");
    // The person's folder: the same branch, the same commit, the same uncommitted change, nothing staged.
    assert.equal(g(r.clone, "rev-parse", "HEAD"), head);
    assert.equal(g(r.clone, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(readFileSync(path.join(r.clone, "app.txt"), "utf8"), "v2, not committed\n");
    assert.equal(g(r.clone, "diff", "--cached", "--name-only"), "");
  } finally {
    r.done();
  }
});

test("somebody else's proof landing first is kept: made again on top of theirs and pushed, never forced", async () => {
  const r = remoteAndClone();
  try {
    await pushProof(r.clone, [{ path: "pr-1/home-one.gif", data: GIF(1) }], "first");
    const theirs = await pushProof(r.other, [{ path: "pr-2/home-two.gif", data: GIF(2) }], "theirs");
    // Between our fetch and our push, the other clone pushes again.
    let theirsAgain = "";
    const ours = await pushProof(r.clone, [{ path: "pr-3/home-three.gif", data: GIF(3) }], "ours", {
      beforePush: async () => void (theirsAgain = (await pushProof(r.other, [{ path: "pr-4/home-four.gif", data: GIF(4) }], "theirs again")).commit),
    });
    assert.equal(g(r.remote, "rev-parse", "friday-proof"), ours.commit);
    assert.equal(g(r.remote, "rev-parse", "friday-proof^"), theirsAgain, "ours sits on theirs");
    assert.ok(g(r.remote, "merge-base", "--is-ancestor", theirs.commit, "friday-proof") === "", "nothing of theirs was lost");
    assert.deepEqual(g(r.remote, "ls-tree", "-r", "--name-only", "friday-proof").split("\n").sort(), ["README.md", "pr-1/home-one.gif", "pr-2/home-two.gif", "pr-3/home-three.gif", "pr-4/home-four.gif"]);
  } finally {
    r.done();
  }
});

test("pr.proof refuses what isn't a pull request, a clip without a GIF, and a folder that pushes elsewhere", async () => {
  const r = remoteAndClone();
  try {
    const gif = GIF(1).toString("base64");
    assert.deepEqual(await prProof({ cwd: r.clone, pr: { url: "https://example.com/x" }, page: "/", gifs: { after: gif } }), { error: "That isn't a GitHub pull request link." });
    assert.match(String(((await prProof({ cwd: r.clone, pr: { url: "https://github.com/acme/web/pull/3" }, page: "/", gifs: { after: "bm90IGEgZ2lm" } })) as { error: string }).error), /no GIF/);
    assert.match(String(((await prProof({ cwd: r.clone, pr: { url: "https://github.com/acme/web/pull/3" }, page: "/", gifs: { after: gif } })) as { error: string }).error), /not to acme\/web/);
    assert.equal(g(r.remote, "branch", "--list", "friday-proof"), "", "nothing was pushed for a pull request elsewhere");
  } finally {
    r.done();
  }
});

test("proofBlock says what changed and the files first, before the picture", async () => {
  const { proofBlock } = await import("../src/proof-block.js");
  const b = proofBlock({ page: "/", after: "https://x/a.gif", summary: "I changed the heading\nand added a line. <!-- x -->", files: ["index.html", "src/`app`.css"] });
  const lines = b.split("\n");
  const what = lines.findIndex((l) => l.startsWith("**What changed:**"));
  const pic = lines.findIndex((l) => l.startsWith("!["));
  assert.ok(what > 0 && what < pic);
  assert.equal(lines[what], "**What changed:** I changed the heading and added a line.  x");
  assert.ok(lines.includes("Files: `index.html`, `src/app.css`"));
});

