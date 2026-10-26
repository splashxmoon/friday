import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { AgentError } from "./agents.js";
import type { SkillInput } from "./skills.js";

/**
 * Skills from a GitHub repository.
 *
 * The convention people already publish is a folder with a SKILL.md in it: a
 * little front matter naming the skill and saying when it applies, then the
 * instructions, with reference files beside it. A repository can hold one of
 * these or a few hundred. This reads that shape and nothing else, from public
 * repositories, and hands back the same fields a skill written by hand has, so
 * an imported skill is an ordinary skill from then on.
 *
 * Two steps, because the first is a question and the second is a decision:
 * `discoverSkills` lists what is there, and `readSkills` fetches the ones the
 * person chose. Nothing is saved by either.
 *
 * Only github.com is ever contacted, and only for the repository named: the
 * address is parsed into owner/repo/branch/path and the requests are built
 * from those parts, never from the text the person pasted.
 */

export type Fetcher = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown>; arrayBuffer?(): Promise<ArrayBuffer>; headers: { get(k: string): string | null } }>;

export interface RepoRef {
  owner: string;
  repo: string;
  /** A branch, tag or commit; "HEAD" is the default branch. */
  ref: string;
  /** Only skills under this folder, when the address pointed inside the repository. */
  path: string;
}

export interface FoundSkill {
  /** Path of the SKILL.md within the repository. */
  path: string;
  name: string;
  description: string;
}

export interface ImportableSkill extends SkillInput {
  source: { repo: string; path: string };
  /** Files beside the skill that weren't brought along (scripts, binaries, anything large). */
  leftBehind: number;
}

const MAX_LISTED = 1000;
const HEADS_FETCHED = 150;
const MAX_FILE = 200_000;
const TIMEOUT_MS = 15_000;

export const MAX_PER_IMPORT = 25;

/** `owner/repo`, or any github.com address that names one, including a folder or a file inside it. */
export function parseRepo(input: string): RepoRef {
  const text = input.trim().replace(/[)\].,;]+$/, "");
  const plain = text.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (plain) return { owner: plain[1]!, repo: plain[2]!.replace(/\.git$/, ""), ref: "HEAD", path: "" };
  const m = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/?#]+)(?:\/([^?#]*))?)?\/?(?:[?#].*)?$/i);
  if (!m) throw new AgentError(400, "That doesn't look like a GitHub repository. Paste an address like github.com/owner/repo.");
  const path = (m[4] ?? "").replace(/\/+$/, "");
  return { owner: m[1]!, repo: m[2]!, ref: m[3] ?? "HEAD", path: /\/skill\.md$/i.test(path) ? path.replace(/\/[^/]*$/, "") : path };
}

const api = (r: RepoRef) => `https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${encodeURIComponent(r.ref)}?recursive=1`;
const raw = (r: RepoRef, path: string) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${encodeURIComponent(r.ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "friday-skill-import" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function get(fetcher: Fetcher, url: string, hdrs?: Record<string, string>) {
  try {
    return await fetcher(url, { headers: hdrs ?? { "User-Agent": "friday-skill-import" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AgentError(502, "Couldn't reach GitHub. Check the connection and try again.");
  }
}

interface TreeFile {
  path: string;
  size: number;
}

/**
 * A repository, downloaded once.
 *
 * GitHub's API gives an address without a token sixty requests an hour, and
 * listing a repository then reading each skill is hundreds of them. The
 * archive GitHub serves for browsers is not counted against that: one download
 * of the whole repository, which is also faster (a few seconds for a repository
 * of hundreds of skills) and brings every file with it. So this is the way in,
 * and the API and the per-file requests are what is left if it can't be had.
 *
 * Only what a skill can use is kept as text: documents and small data files.
 * Everything else is counted and dropped.
 */
export interface Snapshot {
  files: Map<string, { size: number; text?: string }>;
}

const ARCHIVE_MAX = 150 * 1024 * 1024;
const KEEP_TEXT_MAX = 80 * 1024 * 1024;
const KEEP_EXT = /\.(md|markdown|txt|json|ya?ml|csv)$/i;

const unzip = promisify(gunzip);

/** The files in a tar archive, with the one top folder GitHub adds stripped off. Pax and GNU long names are honoured. */
export function readTar(tar: Buffer, wantText: (path: string, size: number) => boolean): Snapshot {
  const files = new Map<string, { size: number; text?: string }>();
  let kept = 0;
  let longName: string | null = null;
  let off = 0;
  const cstr = (b: Buffer) => {
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? b.length : z).toString("utf8");
  };
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const body = off + 512;
    let name = cstr(h.subarray(0, 100));
    const prefix = cstr(h.subarray(345, 500));
    if (prefix && h.subarray(257, 262).toString() === "ustar") name = `${prefix}/${name}`;
    if (type === "x" || type === "g") {
      // Pax records: "<length> key=value\n". Only a path matters here.
      const text = tar.subarray(body, body + size).toString("utf8");
      let i = 0;
      while (i < text.length) {
        const sp = text.indexOf(" ", i);
        const len = parseInt(text.slice(i, sp), 10);
        if (!len) break;
        const rec = text.slice(sp + 1, i + len - 1);
        if (type === "x" && rec.startsWith("path=")) longName = rec.slice(5);
        i += len;
      }
    } else if (type === "L") {
      longName = cstr(tar.subarray(body, body + size));
    } else if (type === "0" || type === "\0") {
      const full = (longName ?? name).replace(/\/+$/, "");
      longName = null;
      const slash = full.indexOf("/");
      const path = slash < 0 ? full : full.slice(slash + 1);
      if (path) {
        if (wantText(path, size) && kept + size <= KEEP_TEXT_MAX) {
          files.set(path, { size, text: tar.subarray(body, body + Math.min(size, MAX_FILE)).toString("utf8") });
          kept += size;
        } else files.set(path, { size });
      }
    } else longName = null;
    off = body + Math.ceil(size / 512) * 512;
  }
  return { files };
}

const snapshots = new WeakMap<object, Map<string, { at: number; value: Snapshot | null }>>();
const SNAPSHOT_TTL_MS = 10 * 60_000;
const snapKey = (r: RepoRef) => `${r.owner}/${r.repo}@${r.ref}`.toLowerCase();

/** What is already downloaded, without going to GitHub. */
function snapshotFor(fetcher: Fetcher, r: RepoRef): Snapshot | null {
  const hit = snapshots.get(fetcher)?.get(snapKey(r));
  return hit && Date.now() - hit.at < SNAPSHOT_TTL_MS ? hit.value : null;
}

/** The repository as one archive, or null when it can't be had that way (the caller then asks the API). */
async function snapshotOf(fetcher: Fetcher, r: RepoRef): Promise<Snapshot | null> {
  const mem = snapshots.get(fetcher) ?? snapshots.set(fetcher, new Map()).get(fetcher)!;
  const hit = mem.get(snapKey(r));
  if (hit && Date.now() - hit.at < SNAPSHOT_TTL_MS) return hit.value;
  let value: Snapshot | null = null;
  try {
    const res = await get(fetcher, `https://codeload.github.com/${r.owner}/${r.repo}/tar.gz/${encodeURIComponent(r.ref)}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (res.ok && res.arrayBuffer && !(len > ARCHIVE_MAX)) {
      const gz = Buffer.from(await res.arrayBuffer());
      if (gz.length <= ARCHIVE_MAX) value = readTar(await unzip(gz), (path, size) => size <= MAX_FILE && (KEEP_EXT.test(path) || /(^|\/)skill\.md$/i.test(path)));
    }
  } catch {
    value = null;
  }
  mem.set(snapKey(r), { at: Date.now(), value });
  if (mem.size > 8) mem.delete(mem.keys().next().value!);
  return value;
}

const TREE_TTL_MS = 5 * 60_000;
// One memory per fetch function: the server has the one global fetch, and a test that fakes GitHub has its own.
const memory = new WeakMap<object, Map<string, { at: number; value: { files: TreeFile[]; truncated: boolean } }>>();

/**
 * Every file in the repository, as paths. GitHub caps very large trees; that is
 * reported, not hidden.
 *
 * Remembered for a few minutes, because looking and then importing is two
 * steps on the same repository, and GitHub gives an address without a token
 * only sixty of these an hour. Setting GITHUB_TOKEN on the server lifts that to
 * five thousand; without it, the second step and every retry cost nothing.
 */
async function listFiles(fetcher: Fetcher, r: RepoRef): Promise<{ files: TreeFile[]; truncated: boolean }> {
  const key = `${r.owner}/${r.repo}@${r.ref}`.toLowerCase();
  const trees = memory.get(fetcher) ?? memory.set(fetcher, new Map()).get(fetcher)!;
  const hit = trees.get(key);
  if (hit && Date.now() - hit.at < TREE_TTL_MS) return hit.value;
  // The whole repository in one download first: no request counted against GitHub's API limit, and the files come with it.
  const snap = await snapshotOf(fetcher, r);
  if (snap) {
    const value = { files: [...snap.files].map(([path, f]) => ({ path, size: f.size })), truncated: false };
    trees.set(key, { at: Date.now(), value });
    return value;
  }
  const res = await get(fetcher, api(r), headers());
  if (res.status === 404) throw new AgentError(404, `Couldn't find ${r.owner}/${r.repo}. It may be private, or the address may be wrong.`);
  if (res.status === 403 || res.status === 429) {
    // The advice belongs in the server log; the person just needs to know it is not their fault and will pass.
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    console.warn(`[skill-import] GitHub rate limit for ${r.owner}/${r.repo}${reset ? `, lifts at ${new Date(reset * 1000).toISOString()}` : ""}${process.env.GITHUB_TOKEN ? "" : ". Set GITHUB_TOKEN to raise it."}`);
    throw new AgentError(429, "GitHub is busy right now. Give it a few minutes and try again.");
  }
  if (!res.ok) throw new AgentError(502, `GitHub answered ${res.status}. Try again in a moment.`);
  const body = (await res.json()) as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
  const files = (body.tree ?? []).filter((t) => t.type === "blob").map((t) => ({ path: t.path, size: t.size ?? 0 }));
  const value = { files, truncated: !!body.truncated };
  trees.set(key, { at: Date.now(), value });
  if (trees.size > 20) trees.delete(trees.keys().next().value!);
  return value;
}

const isSkillFile = (p: string) => /(^|\/)skill\.md$/i.test(p);
const under = (p: string, dir: string) => !dir || p === dir || p.startsWith(`${dir}/`);

async function readText(fetcher: Fetcher, r: RepoRef, path: string): Promise<string | null> {
  const here = snapshotFor(fetcher, r)?.files.get(path);
  if (here?.text !== undefined) return here.text;
  const res = await get(fetcher, raw(r, path));
  if (!res.ok) return null;
  return (await res.text()).slice(0, MAX_FILE);
}

/** Front matter between --- lines: plain `key: value`, quoted values, and folded or literal blocks. */
export function parseSkillFile(text: string): { meta: Record<string, string>; body: string } {
  const clean = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = clean.match(/^---\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!m) return { meta: {}, body: clean.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    let value = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(value.startsWith(">") ? " " : "\n").trim();
    } else if (!value) {
      // A bare key followed by indented continuation lines.
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(" ").trim();
    }
    meta[key] = value.replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return { meta, body: clean.slice(m[0].length).trim() };
}

const humanize = (s: string) => {
  const t = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : "";
};

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Repositories often keep the same skills twice: once as the thing itself and
 * again under a folder for each tool that reads them (.claude/skills,
 * .gemini/skills, .codex/skills). The copies are not a choice worth offering,
 * so a skill that also exists outside a dot-folder is listed once, from there.
 * Folders named for the template or the readme are scaffolding, not skills.
 */
function withoutCopies(paths: string[]): { keep: string[]; hidden: number } {
  const folder = (p: string) => baseOf(dirOf(p)).toLowerCase();
  const scaffolding = (p: string) => /^(template|templates|readme|example|examples)$/.test(folder(p));
  const real = paths.filter((p) => !scaffolding(p));
  const hiddenDir = (p: string) => p.split("/").slice(0, -1).some((seg) => seg.startsWith("."));
  const visible = new Set(real.filter((p) => !hiddenDir(p)).map(folder));
  const keep = real.filter((p) => !hiddenDir(p) || !visible.has(folder(p)));
  // Of the copies that remain, one per folder name: the first by path.
  const seen = new Set<string>();
  const unique = keep.sort().filter((p) => (seen.has(folder(p)) ? false : (seen.add(folder(p)), true)));
  return { keep: unique, hidden: paths.length - unique.length };
}

/** What is in this repository that is a skill, with the name and description each one gives itself. */
export async function discoverSkills(fetcher: Fetcher, input: string): Promise<{ repo: RepoRef; skills: FoundSkill[]; truncated: boolean; more: number; hidden: number }> {
  const repo = parseRepo(input);
  const { files, truncated } = await listFiles(fetcher, repo);
  const every = files.filter((f) => isSkillFile(f.path) && under(f.path, repo.path)).map((f) => f.path);
  const { keep, hidden } = withoutCopies(every);
  const found = keep.sort();
  if (!found.length) {
    throw new AgentError(404, "No skills found there. A skill is a folder with a SKILL.md file in it; this repository doesn't have any" + (repo.path ? ` under ${repo.path}.` : "."));
  }
  const listed = found.slice(0, MAX_LISTED);
  const out: FoundSkill[] = listed.map((path) => ({ path, name: humanize(baseOf(dirOf(path)) || repo.repo), description: "" }));

  // The names and descriptions live in the files, so read the first of them,
  // a few at a time: enough to choose by, without a request per skill for a
  // repository that has hundreds.
  const heads = out.slice(0, HEADS_FETCHED);
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < heads.length) {
        const s = heads[next++]!;
        const text = await readText(fetcher, repo, s.path).catch(() => null);
        if (!text) continue;
        const { meta } = parseSkillFile(text);
        if (meta.name) s.name = humanize(meta.name);
        s.description = (meta.description ?? "").slice(0, 200);
      }
    }),
  );
  return { repo, skills: out, truncated, more: found.length - listed.length, hidden };
}

const RESOURCE_EXT = /\.(md|markdown|txt|json|ya?ml|csv)$/i;
const SKIP_NAME = /^(readme|license|licence|changelog|contributing)(\.|$)/i;

/** Fetch the chosen skills, in the shape the registry stores. */
export async function readSkills(fetcher: Fetcher, input: string, paths: string[], opts: { limit?: number; resourcesPerSkill?: number } = {}): Promise<{ skills: ImportableSkill[]; skipped: string[]; repo: RepoRef }> {
  const repo = parseRepo(input);
  const limit = opts.limit ?? MAX_PER_IMPORT;
  const maxResources = opts.resourcesPerSkill ?? 5;
  const chosen = [...new Set(paths)].filter(isSkillFile).slice(0, limit);
  if (!chosen.length) throw new AgentError(400, "Choose at least one skill to import.");
  const { files } = await listFiles(fetcher, repo);
  const have = new Set(files.map((f) => f.path));
  const results: (ImportableSkill | null)[] = new Array(chosen.length).fill(null);
  const skipped: string[] = [];

  const one = async (path: string): Promise<ImportableSkill | null> => {
    if (!have.has(path)) return null;
    const text = await readText(fetcher, repo, path).catch(() => null);
    if (!text) return null;
    const { meta, body } = parseSkillFile(text);
    const dir = dirOf(path);
    const name = (humanize(meta.name ?? "") || humanize(baseOf(dir)) || humanize(repo.repo)).slice(0, 40);
    if (!body.trim()) return null;

    // The instruction has a hard size; what doesn't fit moves to a resource, so
    // nothing the author wrote is silently cut.
    const LIMIT = 7800;
    let instructions = body;
    const resources: { name: string; text: string }[] = [];
    if (body.length > LIMIT) {
      const cut = body.lastIndexOf("\n\n", LIMIT);
      const at = cut > LIMIT / 2 ? cut : LIMIT;
      instructions = `${body.slice(0, at).trim()}\n\n(The rest of this skill continues in the reference “Continued”.)`;
      resources.push({ name: "Continued", text: body.slice(at).trim() });
    }

    const beside = files.filter((f) => f.path !== path && under(f.path, dir) && dir !== "" && !isSkillFile(f.path));
    const usable = beside.filter((f) => RESOURCE_EXT.test(f.path) && !SKIP_NAME.test(baseOf(f.path)) && f.size <= MAX_FILE);
    // References and templates first, nearest to the skill first: those are the ones its instructions point at.
    usable.sort((a, b) => Number(/references?\//i.test(b.path)) - Number(/references?\//i.test(a.path)) || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
    for (const f of usable) {
      if (resources.length >= maxResources) break;
      const t = await readText(fetcher, repo, f.path).catch(() => null);
      if (t?.trim()) resources.push({ name: f.path.slice(dir.length + 1).slice(0, 80), text: t });
    }

    const words = `${name} ${meta.description ?? ""}`.toLowerCase().match(/[a-z][a-z0-9+#-]{3,}/g) ?? [];
    return {
      name,
      description: (meta.description ?? "").slice(0, 200),
      instructions,
      icon: "book",
      keywords: [...new Set(words)].slice(0, 8),
      resources,
      source: { repo: `${repo.owner}/${repo.repo}`, path },
      leftBehind: Math.max(0, beside.length - resources.filter((r) => r.name !== "Continued").length),
    };
  };

  // A few at a time: a repository of hundreds is a few hundred requests, and
  // GitHub's raw host is happy with that as long as it is not all at once.
  let next = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (next < chosen.length) {
        const i = next++;
        results[i] = await one(chosen[i]!).catch(() => null);
        if (!results[i]) skipped.push(chosen[i]!);
      }
    }),
  );
  return { skills: results.filter((r): r is ImportableSkill => !!r), skipped, repo };
}

export const MAX_COLLECTION = 500;

/** Every skill path worth importing from a repository: what discovery lists, minus copies. */
export async function allSkillPaths(fetcher: Fetcher, input: string): Promise<{ repo: RepoRef; paths: string[]; more: number }> {
  const found = await discoverSkills(fetcher, input);
  return { repo: found.repo, paths: found.skills.map((s) => s.path), more: found.more };
}

type Registry = Pick<import("./skills.js").SkillRegistry, "importCollection" | "importMany">;
type Person = import("./agents.js").Person;

/** A whole repository as one collection, without choosing. */
export async function importWholeRepo(fetcher: Fetcher, registry: Registry, user: Person, url: string) {
  const { repo, paths, more } = await allSkillPaths(fetcher, url);
  // Leaner than a hand-picked import: a couple of reference files each, because
  // four hundred skills with five files apiece is a lot to pull and to carry.
  const { skills, skipped } = await readSkills(fetcher, url, paths, { limit: MAX_COLLECTION, resourcesPerSkill: 2 });
  if (!skills.length) throw new AgentError(404, "None of the skills in that repository could be read.");
  const done = await registry.importCollection(user, `${repo.owner}/${repo.repo}`, repo.path, skills);
  return { ...done, skipped, more: Math.max(0, more + (paths.length - skills.length - skipped.length)) };
}

/** Particular skills, added on their own rather than inside a collection. */
export async function importChosen(fetcher: Fetcher, registry: Registry, user: Person, url: string, paths: string[]) {
  const { skills, skipped } = await readSkills(fetcher, url, paths);
  const done = await registry.importMany(user, skills);
  return { ...done, skipped, leftBehind: skills.reduce((n, x) => n + x.leftBehind, 0) };
}
