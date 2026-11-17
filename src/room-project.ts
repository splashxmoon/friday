/**
 * A room's project: the repo its work is on, and the branch that work starts from (splashxmoon/friday#24, "Let a room name its
 * project repo"). A reference, never a checkout: the room doesn't clone, add the repo to anyone's folders, or switch a branch.
 * Each crew mate keeps its own folder; the room only finds which of them holds a copy of the repo, on the computer it runs on.
 */
export interface RoomProject {
  /**
   * Canonical: https://host/owner/repo, no credentials, no `.git`. Or a folder on the room's computer, its absolute path (Arun,
   * 2026-11-17: "also add support for folders too"): the crew there works in that folder itself, with no copy and no branch.
   */
  repo: string;
  /** The baseline for the room's work. Absent: the repo's default branch. A folder has none. */
  branch?: string;
}

/** An absolute folder: /x, C:\x or C:/x, \\server\share. */
export const isFolderPath = (s: string) => /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(s.trim());
/** Whether the room's project is a folder on its computer rather than a repo. */
export const isFolderProject = (p: Pick<RoomProject, "repo">) => isFolderPath(p.repo);
/** A folder's last part, for people: /Users/me/Desktop/edge-app is edge-app. */
export const folderName = (dir: string) => dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || dir;

/** Where one crew mate stands with the room's project, on its own computer. */
export type MemberRepo =
  /** One copy found. `branch` is "missing" when the room names a branch this copy has neither locally nor from a remote. */
  | { state: "resolved"; path: string; branch?: "present" | "missing" }
  /** More than one of its project folders is that repo: listed, never one picked silently. */
  | { state: "ambiguous"; paths: string[] }
  /** None of its folders is that repo. */
  | { state: "unresolved" }
  /**
   * Its folders can't be looked at from here, so nothing is known either way: its computer is away (`away`, and a task on the
   * repo waits for it), or it is another computer, linked, that Friday can't look in yet (it may take the task, told to work in
   * its own copy and say so if it has none).
   */
  | { state: "unchecked"; why: string; away?: true };

const SCHEMES = new Set(["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"]);

/**
 * A remote as host/owner/repo, lowercased, for matching: `git@github.com:Owner/Repo.git`, `ssh://git@github.com/owner/repo` and
 * `https://github.com/owner/repo/` are one repo. `owner/repo` alone is GitHub's. Null for a local path or anything else.
 */
export function repoKey(raw: string): string | null {
  const r = parseRepo(raw);
  return r ? `${r.host}/${r.parts.join("/")}`.toLowerCase() : null;
}

/** A remote's host and path parts, in the case they were written. */
function parseRepo(raw: string): { host: string; parts: string[] } | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  let host: string;
  let rest: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (!SCHEMES.has(u.protocol.toLowerCase())) return null;
    host = u.hostname;
    rest = decodeURIComponent(u.pathname);
  } else {
    // scp-like: [user@]host:owner/repo. Not a Windows drive (C:\x, C:/x), not a path.
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(s);
    if (scp && !/^[a-z]$/i.test(scp[1]!)) {
      host = scp[1]!;
      rest = scp[2]!;
    } else if (/^[\w.-]+\/[\w.-]+$/.test(s) && !/^\.{1,2}\//.test(s)) {
      host = "github.com";
      rest = s;
    } else return null;
  }
  const parts = rest.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (!host || parts.length < 2 || parts.some((p) => p === "." || p === "..")) return null;
  return { host: host.toLowerCase(), parts };
}

/** A branch name git would take, roughly (git check-ref-format's rules that people hit). */
export function okBranch(b: string): boolean {
  return (
    b.length > 0 &&
    b.length <= 200 &&
    !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(b) &&
    !b.startsWith("-") &&
    !b.startsWith("/") &&
    !b.endsWith("/") &&
    !b.endsWith(".") &&
    !b.endsWith(".lock") &&
    !b.includes("..") &&
    !b.includes("//") &&
    !b.includes("@{") &&
    b !== "@"
  );
}

/**
 * The project as the page sends it: a repo URL or `owner/repo`, and a branch or blank; or a folder's absolute path, which takes
 * no branch. `null` (or a blank repo) is "No project". `undefined` when it wasn't sent at all. Refused: a relative path or `~`
 * (the page sends a folder whole), and a URL with a password or token in it.
 */
export function cleanProject(v: unknown): RoomProject | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const o = typeof v === "string" ? { repo: v } : typeof v === "object" ? (v as Record<string, unknown>) : null;
  if (!o) throw new Error("A project is a repo, and a branch if you like.");
  const raw = typeof o.repo === "string" ? o.repo.trim() : "";
  if (!raw) return null;
  if (raw.length > 400) throw new Error("That repo address is too long.");
  if (isFolderPath(raw)) {
    if (/[\x00-\x1f]/.test(raw) || raw.split(/[\\/]/).includes("..")) throw new Error("That isn't a folder Friday can use. Pick it again.");
    return { repo: raw.length > 1 ? raw.replace(/[\\/]+$/, "") || raw : raw };
  }
  if (/^[~.]/.test(raw) || /^file:/i.test(raw)) throw new Error("Give the repo's address, like owner/repo or https://github.com/owner/repo, or pick the folder whole.");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (scheme) {
    let u: URL | null = null;
    try {
      u = new URL(raw);
    } catch {
      /* said below */
    }
    // A password, or any name at all on a web address (a token passed as the user name): never stored.
    if (u && (u.password || (/^https?:$/i.test(u.protocol) && u.username))) throw new Error("Leave the sign-in out of the address: no names, passwords or tokens in it.");
  } else if (/^[^@/\s]+:[^@/\s]+@/.test(raw)) throw new Error("Leave the sign-in out of the address: no names, passwords or tokens in it.");
  const r = parseRepo(raw);
  if (!r) throw new Error("That isn't a repo address. Use owner/repo for GitHub, or the repo's URL.");
  const branch = typeof o.branch === "string" ? o.branch.trim() : "";
  if (branch && !okBranch(branch)) throw new Error(`"${branch.slice(0, 60)}" isn't a branch name git would take.`);
  return { repo: `https://${r.host}/${r.parts.join("/")}`, ...(branch ? { branch } : {}) };
}

/** The repo for people: `owner/repo` on GitHub, `host/owner/repo` elsewhere; a folder by its last part. */
export function repoName(repo: string): string {
  if (isFolderPath(repo)) return folderName(repo);
  const k = repo.replace(/^https?:\/\//i, "");
  return /^github\.com\//i.test(k) ? k.slice("github.com/".length) : k;
}

/** `owner/repo · branch`, or `· default` when the room names no branch (never a guess at what the default is). */
export const showProject = (p: RoomProject) => `${repoName(p.repo)} · ${isFolderProject(p) ? "folder" : (p.branch ?? "default")}`;

/** Runs git in a folder: its output, or a throw when git fails (no repo there, no git). */
export type Git = (cwd: string, args: string[]) => Promise<string>;

/** A folder's repo as git sees it: its top folder and every remote's key. Null when it isn't in a repo. */
export async function repoAt(git: Git, dir: string): Promise<{ top: string; keys: Set<string>; urls: string[] } | null> {
  const said = (await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  if (!said) return null;
  // Git on Windows says C:/Users/…; the rest of Friday (and every folder it is compared with) says C:\Users\…. Without node:path:
  // the app's pages import this file too.
  const top = /^[A-Za-z]:\//.test(said) ? said.replace(/\//g, "\\") : said;
  const remotes = await git(dir, ["remote", "-v"]).catch(() => "");
  const urls = [...new Set(remotes.split("\n").map((l) => l.split(/\s+/)[1] ?? "").filter(Boolean))];
  const keys = new Set(urls.map(repoKey).filter((k): k is string => !!k));
  return { top, keys, urls };
}

/** The copy's ref for the branch: its own, else a remote's (fetched, not checked out). Null when it has neither. */
export async function branchRef(git: Git, dir: string, branch: string): Promise<string | null> {
  const [refs, remotes] = await Promise.all([git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).catch(() => ""), git(dir, ["remote"]).catch(() => "")]);
  const have = new Set(refs.split("\n").map((l) => l.trim()).filter(Boolean));
  if (have.has(`refs/heads/${branch}`)) return `refs/heads/${branch}`;
  const r = remotes
    .split("\n")
    .map((x) => x.trim())
    .find((x) => x && have.has(`refs/remotes/${x}/${branch}`));
  return r ? `refs/remotes/${r}/${branch}` : null;
}

/**
 * One crew mate and the room's project: its project folders first, then its own folder. More than one project folder on the repo
 * is ambiguous; none there and its own folder isn't either is unresolved. Matched on the remote, never the folder's name.
 */
export async function resolveMember(project: RoomProject, folders: { projects: readonly string[]; own?: string }, git: Git, /** Whether a folder is there (a folder project's own). */ exists: (dir: string) => Promise<boolean> = async () => true): Promise<MemberRepo> {
  // A folder: everyone on its computer works in it, as it is.
  if (isFolderProject(project)) return (await exists(project.repo).catch(() => false)) ? { state: "resolved", path: project.repo } : { state: "unresolved" };
  const want = repoKey(project.repo);
  if (!want) return { state: "unresolved" };
  const matches = async (dirs: readonly string[]) => {
    const tops = new Set<string>();
    for (const d of dirs) {
      const r = await repoAt(git, d);
      if (r?.keys.has(want)) tops.add(r.top);
    }
    return [...tops];
  };
  let found = await matches(folders.projects);
  if (!found.length && folders.own) found = await matches([folders.own]);
  if (found.length > 1) return { state: "ambiguous", paths: found };
  if (!found.length) return { state: "unresolved" };
  const at = found[0]!;
  if (!project.branch) return { state: "resolved", path: at };
  return { state: "resolved", path: at, branch: (await branchRef(git, at, project.branch)) ? "present" : "missing" };
}

/** Whether a task that needs the repo can run on this crew mate now: one copy, with the room's branch when it names one. */
export const ready = (m: MemberRepo | undefined): boolean => (m?.state === "resolved" && m.branch !== "missing") || (m?.state === "unchecked" && !m.away);

/** Why a crew mate can't take a task on the repo yet, in a few words: "has no copy of owner/repo". */
export function notReadyWhy(m: MemberRepo | undefined, p: RoomProject): string {
  const name = repoName(p.repo);
  if (isFolderProject(p)) return m?.state === "resolved" ? "" : `can't reach the folder ${p.repo}${m?.state === "unchecked" ? `: ${m.why}` : ", on the room's computer"}`;
  if (!m || m.state === "unresolved") return `has no copy of ${name}`;
  if (m.state === "ambiguous") return `has ${m.paths.length} copies of ${name} (${m.paths.join(", ")}) and needs just one among its folders`;
  if (m.state === "unchecked") return `couldn't be checked for ${name}: ${m.why}`;
  if (m.branch === "missing") return `has ${name} but not the branch ${p.branch}: fetch it in its copy, without switching`;
  return "";
}

/** A crew mate's turn in a room with a project: the repo, the branch, and its own copy, or that it has none to work in. */
export function projectNote(p: RoomProject, m: MemberRepo | undefined): string {
  if (isFolderProject(p)) return m?.state === "resolved" ? `This room's project is the folder ${p.repo}: work on the project there, in that folder itself. The crew in this room shares it, so say what you change.` : `This room's project is the folder ${p.repo}, which you can't reach from where you run: don't do project work in another folder, say so.`;
  const head = `This room's project is ${repoName(p.repo)}, from ${p.branch ? `the branch ${p.branch}` : "its default branch"}.`;
  if (m?.state === "resolved" && m.branch !== "missing") return `${head} Your copy of it is ${m.path}: work on the project there, on a branch of your own. The room never switches your branch.`;
  if (m?.state === "unchecked") return `${head} Work on it in your own copy of that repo; if you have none, say so rather than working in another folder.`;
  if (m?.state === "resolved") return `${head} Your copy is ${m.path}, but it doesn't have ${p.branch} yet: fetch it there (git fetch), without switching your branch, before work on the project.`;
  if (m?.state === "ambiguous") return `${head} More than one of your folders is that repo (${m.paths.join(", ")}): say which to use rather than picking one.`;
  return `${head} None of your folders is a copy of it, so don't do project work in another folder: say you need a copy of it.`;
}

/** A board task's line on the project: where this crew mate does it. */
export function repoLine(p: RoomProject, m: MemberRepo | undefined): string {
  if (isFolderProject(p)) return `[Friday] This task is in the folder ${p.repo}: do it there, in that folder itself.${m?.state === "resolved" ? "" : " You can't reach it from where you run, so say so rather than using another folder."}`;
  const where = m?.state === "resolved" ? ` Your copy of it is ${m.path}: do the task there.` : " Do it in your own copy of that repo; if you have none, say so rather than using another folder.";
  return `[Friday] This task is on ${repoName(p.repo)}, from ${p.branch ? `the branch ${p.branch}` : "its default branch"}.${where}`;
}

/**
 * A copy's branches, newest commit first: its own, then its remotes' that it doesn't have (their remote's name dropped), and the
 * remote's default branch when git knows it (origin/HEAD). For the room's branch picker; nothing is fetched.
 */
export async function branchesAt(git: Git, dir: string): Promise<{ branches: string[]; default?: string }> {
  const [refs, head] = await Promise.all([
    git(dir, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", "refs/heads", "refs/remotes"]).catch(() => ""),
    git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => ""),
  ]);
  const out: string[] = [];
  for (const r of refs.split("\n").map((l) => l.trim())) {
    const b = r.startsWith("refs/heads/") ? r.slice(11) : r.startsWith("refs/remotes/") ? r.slice(13).split("/").slice(1).join("/") : "";
    if (b && b !== "HEAD" && !out.includes(b)) out.push(b);
  }
  const d = head.trim().replace(/^refs\/remotes\/[^/]+\//, "");
  return { branches: out, ...(d ? { default: d } : {}) };
}

/**
 * `git ls-remote --symref <remote> HEAD refs/heads/*` read: the remote's branches, in its order, and its default branch (HEAD's
 * symref). Lines are `ref: refs/heads/main\tHEAD`, then `<sha>\tHEAD` and `<sha>\trefs/heads/<branch>`.
 */
export function parseLsRemote(out: string): { branches: string[]; default?: string } {
  let d: string | undefined;
  const branches: string[] = [];
  for (const line of out.split("\n")) {
    const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (sym) {
      d = sym[1];
      continue;
    }
    const head = /^[0-9a-f]{7,64}\s+refs\/heads\/(\S+)$/.exec(line.trim());
    if (head && !branches.includes(head[1]!)) branches.push(head[1]!);
  }
  return { branches, ...(d ? { default: d } : {}) };
}
