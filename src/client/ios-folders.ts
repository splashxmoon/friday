import type { SessionEvent } from "../types.js";

/**
 * Where else to look for the iOS app, when the session's own folder has no Xcode project (Arun, 2026-10-20: "ios preview isnt
 * showing up"): the agents were building an app in ~/Desktop/edge-app while the session's folder was another repo, so the
 * Preview's iOS side said there was nothing to run. The folders the agents' commands and edits name (a `cd` into it, a file
 * in it), and the folders their coding tools run in, most named first: an .xcodeproj or .xcworkspace named outright first of all.
 * Never the home folder, a catch-all in it (Desktop, Documents…) or a folder the session's own is in: looking through those is
 * slow and finds whichever app is there.
 */

const PATHS = /(?:\/Users|\/home|\/Volumes)\/[^\s"'`;|&<>(){}[\],*?]+/g;
/** Folders right in the home folder that hold many projects rather than being one. */
const CONTAINERS = new Set(["Desktop", "Documents", "Downloads", "Developer", "Projects", "projects", "Code", "code", "src", "dev", "repos", "git", "GitHub", "github", "workspace", "Workspace", "Library", "Sites"]);
/** A command that builds or runs an iOS app: the folders it names are where the app is, not ones it only read. */
const XCODE = /\b(?:xcodebuild|xcodegen|xcrun\s+simctl|simctl|swift\s+(?:build|test))\b|\.xcodeproj|\.xcworkspace|project\.yml/;
/** Folders that hold many projects or copies of them, anywhere: Friday's own and other tools' worktree folders. */
const HOLDERS = /^(?:worktrees|\.worktrees)$/;
/** How many folders are looked through at most: each look asks Xcode, a second or two. */
export const MAX_IOS_FOLDERS = 5;

export function iosFolders(events: SessionEvent[], cwd: string, running: string[] = []): string[] {
  const score = new Map<string, number>();
  // A folder the session's own folder is in holds more than this app (the session's repo, its neighbours): looking through it
  // finds whichever app is beside it.
  const bump = (dir: string, by: number) => {
    if (!dir || dir === cwd || cwd.startsWith(`${dir}/`)) return;
    // A folder holding copies of every repo (~/.friday/worktrees) or a tool's own (~/.friday, ~/.codex) is no app: counted, it
    // outscored the copy the app was really in, since every path under any copy counts for it (Arun, 2026-10-25: Boss Man
    // built and opened the app, and the iOS side said there was no Xcode project).
    const segs = dir.split("/").filter(Boolean);
    if (HOLDERS.test(segs.at(-1) ?? "") || (segs.length === 3 && segs[2]!.startsWith("."))) return;
    score.set(dir, (score.get(dir) ?? 0) + by);
  };
  const take = (raw: string, weight: number) => {
    const p = raw.replace(/[.:]+$/, "").replace(/\/+$/, "");
    const project = /^(.*?)\/[^/]+\.(?:xcodeproj|xcworkspace)(?:\/|$)/.exec(p);
    if (project) bump(project[1]!, 100 * weight);
    const segs = p.split("/").filter(Boolean);
    // A file's own name is not a folder to look in.
    const last = segs.at(-1) ?? "";
    const end = /\.[A-Za-z0-9]{1,10}$/.test(last) && !/\.(?:xcodeproj|xcworkspace|app)$/.test(last) ? segs.length - 1 : segs.length;
    for (let i = end; i >= 3; i--) {
      if (i === 3 && CONTAINERS.has(segs[2]!)) break;
      bump(`/${segs.slice(0, i).join("/")}`, weight);
    }
  };
  for (const r of running) if (r) take(r, 50);
  for (const e of events) {
    // Where an agent said the app is (show_preview's folder): looked in first.
    if (e.body.type === "preview.asked" && e.body.ios && e.body.folder) take(`${e.body.folder}/`, 1000);
    if (e.body.type !== "agent.message") continue;
    for (const c of e.body.toolCalls) {
      const args = (c.arguments ?? "").replace(/\\\//g, "/");
      for (const m of args.matchAll(PATHS)) take(m[0], XCODE.test(args) ? 60 : 1);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .slice(0, MAX_IOS_FOLDERS)
    .map(([dir]) => dir);
}
