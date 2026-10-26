/**
 * "Open in" your own editor, file manager or terminal: the desktop app's side is desktop-native.ts. In a browser there is
 * nothing here (a page can't open VS Code), and an app from before it has no openIn: both leave the menus as they were.
 */
import type { IconName } from "./icons.js";
import type { MenuItem } from "./ui.js";

export type OpenTarget = { id: string; label: string; editor: boolean };

let known: Promise<OpenTarget[]> | null = null;
/** What this computer can open things in, asked of the app once. */
export function openTargets(): Promise<OpenTarget[]> {
  const d = typeof window !== "undefined" ? window.fridayDesktop : undefined;
  if (!d?.openIn || !d.openTargets) return Promise.resolve([]);
  known ??= d.openTargets().catch(() => []);
  return known;
}

const EDITOR_KEY = "mpa.editor";
/** The editor last opened in, so ⌘-click on a file goes where you went last; the first the computer has otherwise. */
export async function preferredEditor(): Promise<OpenTarget | null> {
  const editors = (await openTargets()).filter((t) => t.editor);
  let last = "";
  try {
    last = localStorage.getItem(EDITOR_KEY) ?? "";
  } catch {
    // Blocked storage: the first editor it has.
  }
  return editors.find((t) => t.id === last) ?? editors[0] ?? null;
}

/** Open it; what went wrong, in a sentence, or null. */
export async function openIn(target: OpenTarget, path: string, line?: number): Promise<string | null> {
  const d = window.fridayDesktop;
  if (!d?.openIn) return "Opening in other apps needs the Friday desktop app.";
  if (target.editor)
    try {
      localStorage.setItem(EDITOR_KEY, target.id);
    } catch {
      // Remembering is a courtesy.
    }
  const r = await d.openIn(target.id, path, line).catch((e: Error) => ({ ok: false, error: e.message }));
  return r.ok ? null : (r.error ?? `Couldn't open it in ${target.label}.`);
}

/** A file named relative to the session's folder, as a path on its computer. */
export function joinPath(dir: string, file: string): string {
  if (/^([a-zA-Z]:[\\/]|\/|~)/.test(file)) return file;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${file.replace(/^\.[\\/]/, "")}`;
}

/** The "Open in" part of a menu for a folder: its editors, then the file manager, then the terminals. Empty outside the app. */
export function openInItems(targets: OpenTarget[], path: string, onError: (e: string) => void): (MenuItem | null)[] {
  if (!targets.length || !path) return [];
  return [
    { heading: "Open in" },
    ...targets.map((t) => ({
      label: t.label,
      icon: (t.editor ? "code" : t.id === "files" ? "folderOpen" : "terminal") as IconName,
      onSelect: () => void openIn(t, path).then((e) => e && onError(e)),
    })),
  ];
}
