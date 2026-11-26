import { isFolderProject, repoName, type MemberRepo, type RoomProject } from "../room-project.js";

/**
 * A room's Project in words (splashxmoon/friday-code#24): the words the room dialog, the profile and the board's
 * pages share, apart from its chooser (RoomProject.tsx).
 */

/** The project as the field shows it: owner/repo for GitHub, else its address. */
export const projectText = (p: RoomProject | null | undefined) => (p ? (/^https:\/\/github\.com\//i.test(p.repo) ? repoName(p.repo) : p.repo) : "");

/** What the field sends: the project, or null for No project. */
export const projectBody = (repo: string, branch: string) => (repo.trim() ? { repo: repo.trim(), ...(branch.trim() ? { branch: branch.trim() } : {}) } : null);

/** A server error that is about the project, to show on its field rather than at the foot. */
export const projectError = (m: string) => /\b(repo|address|branch|sign-in|folder)\b/i.test(m);

/** One crew mate and the room's project, in a few words, and whether it is something to fix. */
export function memberLine(m: MemberRepo | undefined, branch: string | undefined, project?: RoomProject): { text: string; tone: "ok" | "warn" | "muted"; title?: string } {
  if (!m) return { text: "Not checked", tone: "muted" };
  // A folder: everyone on its computer works in it; one elsewhere can't.
  if (project && isFolderProject(project)) return m.state === "resolved" ? { text: "Works in it", tone: "ok", title: m.path } : m.state === "unchecked" ? { text: "Another computer", tone: "warn", title: `${m.why}.` } : { text: "Folder not found", tone: "warn", title: `${project.repo} isn't there any more. Pick the folder again.` };
  if (m.state === "resolved") return m.branch === "missing" ? { text: `No ${branch} yet · fetch it`, tone: "warn", title: `${m.path}\nHas the repo but not ${branch}: fetch it there, without switching its branch.` } : { text: m.path, tone: "ok", title: m.path };
  if (m.state === "ambiguous") return { text: `${m.paths.length} copies · pick one`, tone: "warn", title: `More than one of its folders is this repo:\n${m.paths.join("\n")}\nKeep one among its folders.` };
  if (m.state === "unchecked") return { text: "Not checked", tone: "muted", title: m.why };
  return { text: "No copy", tone: "warn", title: "None of its folders is this repo. Add a folder with a copy of it on its own page." };
}
