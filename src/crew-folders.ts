/**
 * Project folders for the crew (Arun, 2026-11-15: "look into placing agents and like crew rooms into project folders too... like
 * categories basically"; of the mockup's three ways, "Folders I make"): folders you name, each holding crew mates and rooms, shown
 * as folding groups in the Agents sidebar. Nothing goes into one by itself; what is in no folder is listed under "Not in a folder".
 *
 * Kept as one record on this computer's Friday, so the app and a browser on it show the same folders. A crew mate or a room is
 * named in `place` by its kind and id ("mate:3f…", "room:a9…"); one removed simply stops being listed, and a folder removed lets
 * what was in it out, never removes it.
 */
export interface CrewFolder {
  id: string;
  name: string;
}
export interface CrewFolders {
  folders: CrewFolder[];
  /** Where each crew mate and room is: its key to its folder's id. In no folder, it isn't here. */
  place: Record<string, string>;
}

export const NO_FOLDERS: CrewFolders = { folders: [], place: {} };
const MAX_FOLDERS = 50;
const MAX_PLACED = 500;
const KEY = /^(mate|room):[\w-]{1,64}$/;
const FOLDER_ID = /^[\w-]{1,40}$/;

/** A record as the page sends it, checked: names trimmed and kept short, ids as they must be, places only into folders that exist. */
export function cleanFolders(raw: unknown): CrewFolders | string {
  if (!raw || typeof raw !== "object") return "Send the groups as { folders, place }.";
  const o = raw as { folders?: unknown; place?: unknown };
  if (!Array.isArray(o.folders)) return "folders should be a list.";
  if (o.folders.length > MAX_FOLDERS) return `At most ${MAX_FOLDERS} groups.`;
  const folders: CrewFolder[] = [];
  const seen = new Set<string>();
  for (const f of o.folders) {
    const id = typeof (f as CrewFolder)?.id === "string" ? (f as CrewFolder).id : "";
    const name = typeof (f as CrewFolder)?.name === "string" ? (f as CrewFolder).name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    if (!FOLDER_ID.test(id) || seen.has(id)) return "Each group needs an id of its own.";
    if (!name) return "A group needs a name.";
    seen.add(id);
    folders.push({ id, name });
  }
  const place: Record<string, string> = {};
  const p = o.place && typeof o.place === "object" ? (o.place as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(p).slice(0, MAX_PLACED)) if (KEY.test(k) && typeof v === "string" && seen.has(v)) place[k] = v;
  return { folders, place };
}

/** The record as kept, or none: what can't be read is no folders, not an error. */
export function readFolders(stored: string | null): CrewFolders {
  if (!stored) return NO_FOLDERS;
  try {
    const c = cleanFolders(JSON.parse(stored));
    return typeof c === "string" ? NO_FOLDERS : c;
  } catch {
    return NO_FOLDERS;
  }
}
