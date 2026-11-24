import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parsePrUrl } from "../pr-feedback.js";
import { proofBlock, proofPath, rawUrl, withProofBlock } from "../proof-block.js";
import { githubSlug, NO_PROMPT } from "./git.js";
import { authEnv } from "./github.js";

/**
 * A proof clip in a pull request (Arun, 2026-11-21: "add clips to PRs and the phone too also see where else we can intergrate it"),
 * through the person's own git and gh, as the rest of Friday's pull request actions are.
 *
 * GitHub plays a video only when it was uploaded on its own site, so the clip goes as a GIF, and it has to live somewhere GitHub serves
 * it from. That is a branch of the repository's own, friday-proof, holding nothing but GIFs, made without touching the folder: the
 * files are written into git's store, put in a tree and a commit on top of whatever friday-proof already holds (never a fresh history
 * over someone else's), and pushed by its id. The working tree, the index and the branch the person is on stay as they were. Then the
 * description gets the block (proof-block.ts) in place of the one before, or added at the end.
 */

type Env = Record<string, string | undefined>;
const BRANCH = "friday-proof";
const TRACKING = `refs/remotes/origin/${BRANCH}`;

function run(cwd: string, bin: string, args: string[], o: { env?: Env; input?: Buffer | string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ...o.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), o.timeout ?? 60_000);
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString();
      if (code === 0) resolve(text);
      else reject(new Error((Buffer.concat(err).toString() || text || `${bin} exited ${code}`).trim()));
    });
    // A git that exits before reading what it is given (most take nothing) closes the pipe: its exit code says how it went, and the
    // write's EPIPE was an uncaught error that took the runner down (v0.4.1's CI, on Linux and macOS).
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}
const git = (cwd: string, args: string[], o: { env?: Env; input?: Buffer | string; timeout?: number } = {}) => run(cwd, "git", ["-c", "core.quotepath=off", ...args], o).then((s) => s.trim());

/** One tree's entries, as `git ls-tree` gives them: mode, type, id and name. */
async function entries(root: string, treeish: string | null): Promise<{ mode: string; type: string; id: string; name: string }[]> {
  if (!treeish) return [];
  const out = await git(root, ["ls-tree", "-z", treeish]).catch(() => "");
  return out
    .split("\0")
    .filter(Boolean)
    .map((l) => {
      const [meta, name] = l.split("\t");
      const [mode, type, id] = meta!.split(" ");
      return { mode: mode!, type: type!, id: id!, name: name! };
    });
}
const mktree = (root: string, list: { mode: string; type: string; id: string; name: string }[]) => git(root, ["mktree", "-z"], { input: list.map((e) => `${e.mode} ${e.type} ${e.id}\t${e.name}\0`).join("") });

const README = "# friday-proof\n\nGIFs of proof clips Friday recorded for this repository's pull requests: the page walked through what changed, shown in each pull request's description. Nothing here is code; the branch can be deleted at any time (the GIFs in older descriptions stop showing).\n";

/**
 * The files added to friday-proof as one commit on top of what origin's friday-proof holds (or as its first commit), pushed by id,
 * without a force: refused because somebody pushed in between, it is fetched and made again on top, once. `beforePush` is for the
 * tests, to push from somewhere else at that moment.
 */
export async function pushProof(root: string, files: { path: string; data: Buffer }[], message: string, o: { env?: Env; beforePush?: () => Promise<void> } = {}): Promise<{ commit: string }> {
  const env = o.env ?? {};
  const fetch = () => git(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${BRANCH}:${TRACKING}`], { env, timeout: 120_000 }).catch((e: Error) => {
    // No friday-proof on the remote yet: the first commit makes it. Anything else (no network, no login) is the real answer.
    if (!/couldn't find remote ref|could not find remote ref|no such ref/i.test(e.message)) throw e;
    return git(root, ["update-ref", "-d", TRACKING]).catch(() => "");
  });
  const ids = await Promise.all(files.map(async (f) => ({ ...f, id: await git(root, ["hash-object", "-w", "--stdin"], { input: f.data }) })));
  // Commits written by Friday say so when this computer's git has no name of its own; with one, they are the person's.
  const named = !!(await git(root, ["config", "user.name"]).catch(() => ""));
  const who: Env = named ? {} : { GIT_AUTHOR_NAME: "Friday", GIT_AUTHOR_EMAIL: "friday@users.noreply.github.com", GIT_COMMITTER_NAME: "Friday", GIT_COMMITTER_EMAIL: "friday@users.noreply.github.com" };
  const build = async (): Promise<string> => {
    const parent = (await git(root, ["rev-parse", "--verify", "--quiet", `${TRACKING}^{commit}`]).catch(() => "")) || null;
    const top = await entries(root, parent);
    if (!parent) top.push({ mode: "100644", type: "blob", id: await git(root, ["hash-object", "-w", "--stdin"], { input: README }), name: "README.md" });
    // Each file into its folder (pr-42/…), the folder's own entries kept.
    const dirs = new Map<string, typeof ids>();
    for (const f of ids) {
      const [dir, ...rest] = f.path.split("/");
      dirs.set(dir!, [...(dirs.get(dir!) ?? []), { ...f, path: rest.join("/") }]);
    }
    for (const [dir, list] of dirs) {
      const had = top.find((e) => e.name === dir && e.type === "tree");
      const inside = (await entries(root, had ? had.id : null)).filter((e) => !list.some((f) => f.path === e.name));
      for (const f of list) inside.push({ mode: "100644", type: "blob", id: f.id, name: f.path });
      const sub = await mktree(root, inside);
      const at = top.findIndex((e) => e.name === dir);
      const entry = { mode: "040000", type: "tree", id: sub, name: dir };
      if (at >= 0) top[at] = entry;
      else top.push(entry);
    }
    const tree = await mktree(root, top);
    return git(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { env: who });
  };
  await fetch();
  let commit = await build();
  for (let attempt = 0; ; attempt++) {
    if (attempt === 0) await o.beforePush?.();
    try {
      await git(root, ["push", "--quiet", "origin", `${commit}:refs/heads/${BRANCH}`], { env, timeout: 180_000 });
      await git(root, ["update-ref", TRACKING, commit]).catch(() => "");
      return { commit };
    } catch (e) {
      const m = (e as Error).message;
      if (attempt > 0 || !/non-fast-forward|fetch first|\[rejected\]|failed to update ref|cannot lock ref|stale info/i.test(m)) throw e;
      // Somebody else's proof landed first: theirs kept, ours made again on top of it.
      await fetch();
      commit = await build();
    }
  }
}

export interface PrProofAsk {
  cwd: string;
  pr: { url: string };
  page: string;
  marks?: { atMs: number; label: string }[];
  /** What was changed, in the agent's words, and the files it touched (clip-summary.ts). */
  summary?: string;
  files?: string[];
  /** base64 GIFs: the walk through the change, and the page before it. */
  gifs: { after: string; before?: string };
}
export type PrProofResult = { ok: true; commit: string; urls: { after: string; before?: string } } | { error: string };

const gifBytes = (b64: unknown): Buffer | null => {
  if (typeof b64 !== "string" || !b64) return null;
  const b = Buffer.from(b64, "base64");
  return b.subarray(0, 6).toString() === "GIF89a" || b.subarray(0, 6).toString() === "GIF87a" ? b : null;
};

/** The GIFs onto friday-proof, then the pull request's description given the proof block. Never throws. */
export async function prProof(a: PrProofAsk): Promise<PrProofResult> {
  const pr = parsePrUrl(String(a?.pr?.url ?? ""));
  if (!pr) return { error: "That isn't a GitHub pull request link." };
  const after = gifBytes(a.gifs?.after);
  if (!after) return { error: "There's no GIF of the clip to put in the pull request." };
  const before = gifBytes(a.gifs?.before);
  if (after.length > 8_000_000 || (before?.length ?? 0) > 8_000_000) return { error: "The GIF is too big for a pull request." };
  const page = typeof a.page === "string" && a.page ? a.page.slice(0, 200) : "/";
  try {
    const root = await git(String(a.cwd ?? ""), ["rev-parse", "--show-toplevel"]).catch(() => "");
    if (!root) return { error: "The folder isn't a git repository." };
    const slug = githubSlug(await git(root, ["remote", "get-url", "origin"]).catch(() => ""));
    if (!slug || slug.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase()) return { error: `This folder pushes to ${slug ?? "no GitHub repository"}, not to ${pr.owner}/${pr.repo}, where the pull request is.` };
    const env = { ...NO_PROMPT, ...(await authEnv()) };
    const id = randomBytes(3).toString("hex");
    const files = [{ path: proofPath(pr.number, page, id), data: after }, ...(before ? [{ path: proofPath(pr.number, page, id, "before"), data: before }] : [])];
    const { commit } = await pushProof(root, files, `Proof for #${pr.number}: ${page}`, { env });
    const urls = { after: rawUrl(pr.owner, pr.repo, commit, files[0]!.path), ...(before ? { before: rawUrl(pr.owner, pr.repo, commit, files[1]!.path) } : {}) };
    // The description as it is now, with the block in place of the old one (or added), back through a file: a long description
    // runs past what a command line holds on Windows.
    const ghEnv = { ...env, GH_PROMPT_DISABLED: "1" };
    const body = await run(root, "gh", ["pr", "view", a.pr.url, "--json", "body", "--jq", ".body"], { env: ghEnv }).then((s) => s.replace(/\n$/, ""));
    const file = path.join(tmpdir(), `friday-proof-${randomUUID()}.md`);
    await writeFile(file, withProofBlock(body, proofBlock({ page, after: urls.after, ...(urls.before ? { before: urls.before } : {}), ...(a.marks?.length ? { marks: a.marks } : {}), ...(a.summary ? { summary: a.summary } : {}), ...(a.files?.length ? { files: a.files } : {}) })));
    try {
      await run(root, "gh", ["pr", "edit", a.pr.url, "--body-file", file], { env: ghEnv });
    } finally {
      await rm(file, { force: true }).catch(() => {});
    }
    return { ok: true, commit, urls };
  } catch (e) {
    const m = (e as Error).message || String(e);
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { error: "gh, GitHub's command line, isn't installed on this computer." };
    if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|permission denied|403/i.test(m)) return { error: "git couldn't sign in to GitHub from this computer to keep the GIF. Push once from a terminal there so it remembers the login." };
    return { error: m.split("\n").slice(-2).join(" ").slice(0, 300) };
  }
}

