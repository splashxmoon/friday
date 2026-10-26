import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import path from "node:path";
import type { FileStore } from "./files.js";
import { readRepo } from "./runner/repo-read.js";
import type { Attachment, RepoCall, SessionEvent } from "./types.js";

/**
 * A folder somebody uploaded, as a folder.
 *
 * Attaching a folder used to mean attaching two hundred files: every one of
 * them inlined into the context window, in a flat list, with no way to see the
 * shape of the project or to look at a file that wasn't already in the
 * message. That is not how anybody works in a codebase, and it cost a fortune.
 *
 * So an uploaded folder becomes a working copy on the server, and everything
 * that already knows how to work in a folder works in it: the agent's
 * list_files, read_file, search_code, write_file and edit_file, and the tree
 * view that draws the same reads for the people watching. No machine has to be
 * linked and no CLI has to be installed — that path is better when you have
 * it, because the work lands in your own checkout, but it is no longer the
 * only path.
 *
 * Running commands here is off by default, and the reason is worth stating
 * plainly. The environment a command gets is built from nothing and its
 * working directory is this folder, but neither is a boundary. The built
 * environment only keeps Friday's keys out of the command's own `env`: it
 * runs as the same user as the server, so on Linux it can read them from
 * /proc/<server pid>/environ, and it can read any file the server can, the
 * server's .env included. `cd ..` is not a guard anybody wrote either, so a
 * shell in one session's folder can read the folder next to it, which
 * belongs to somebody else. None of that is fixed by checking harder — it is
 * fixed by the keys and the other sessions' files not being on the machine
 * at all.
 *
 * So this waits for a container or a microVM per session: its own user and
 * process and mount namespaces, only that session's folder mounted, none of
 * the server's environment, limits on CPU, memory and time, and the network
 * off or filtered. Until then the switch exists for development, where there
 * is one person and no neighbour to read, and a production server refuses it.
 * Everything else about an uploaded folder — reading, searching, editing,
 * git — works either way.
 */

/**
 * Whether an uploaded folder may run commands.
 *
 * Read per call rather than captured once: a test that flips it should not
 * have to restart the process to be believed. Never on a production server,
 * whatever the switch says: there it would hand every uploaded project the
 * server's keys and everyone else's folders (see above).
 */
export const uploadsMayRun = (): boolean => process.env.UPLOAD_SHELL === "1" && process.env.NODE_ENV !== "production";

/** What one session's folder may hold, unpacked. Set where a real project fits and a folder of video does not. */
export const MAX_FOLDER_FILES = 60_000;
export const MAX_FOLDER_BYTES = 2 * 1024 * 1024 * 1024;
/** The archive itself, as it arrives. */
export const MAX_FOLDER_ARCHIVE = 600 * 1024 * 1024;

const modeNow = () => (uploadsMayRun() ? ("full" as const) : ("edits" as const));
const GIT_OPS = new Set<RepoCall["op"]>(["checkpoint", "restore", "commit", "publish", "remote", "branches", "switch", "prcomments", "diff"]);

export interface UploadedFolder {
  root: string;
  /** What the uploaded top-level folder was called, for anything that shows a path. */
  name: string;
  files: number;
}

/** Every file attached to this session's instructions, newest last, deduplicated. */
export function attachmentsIn(events: SessionEvent[]): Attachment[] {
  const out = new Map<string, Attachment>();
  for (const e of events) {
    const b = e.body;
    const atts = b.type === "instruction" || b.type === "suggestion" ? b.attachments : undefined;
    for (const a of atts ?? []) out.set(a.id, a);
  }
  return [...out.values()];
}

/**
 * The folder everything was uploaded under, when there is one.
 *
 * A folder pick arrives as `my-app/src/index.ts`; keeping that first segment
 * would put every path one level deeper than the person who uploaded it sees
 * it. Only stripped when every file agrees — one loose file attached beside
 * the folder means the prefix isn't the root, it's a sibling.
 */
export function commonRoot(names: string[]): string {
  if (names.length < 2) return "";
  const first = names[0]!.split("/")[0]!;
  if (!names[0]!.includes("/")) return "";
  return names.every((n) => n.startsWith(`${first}/`)) ? first : "";
}

/**
 * Materialises uploads into a per-session folder, and reads them back.
 *
 * Lazy: nothing is written until somebody asks to look, so a session that
 * attaches two files and never opens the tree costs one directory it never
 * creates. Written once per file — the blobs are immutable, so a file already
 * on disk is the file.
 */
export class UploadedFolders {
  /** Files already written, by session, so a second read is a no-op. */
  private done = new Map<string, Set<string>>();

  constructor(
    private files: FileStore,
    private dir: string,
  ) {}

  rootFor(sid: string): string {
    return path.join(this.dir, sid.replace(/[^\w-]/g, ""));
  }

  /**
   * The environment a process started in this folder gets.
   *
   * The same build-from-nothing the shell uses, and for the same reason: a
   * dev server from an uploaded project runs on Friday's machine, and
   * `process.env` there holds Friday's keys. That keeps them out of its own
   * environment and no further (see the note at the top of this file).
   */
  envFor(sid: string): NodeJS.ProcessEnv {
    const root = this.rootFor(sid);
    return {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      TMPDIR: path.join(root, ".tmp"),
      LANG: process.env.LANG ?? "en_US.UTF-8",
    };
  }

  /**
   * Write what hasn't been written yet, and say what is there.
   *
   * Only text: an uploaded PNG has nothing useful to offer `read_file`, and
   * writing binaries out to give the tree more rows to draw would be work
   * done for nobody.
   */
  async ensure(sid: string, atts: Attachment[]): Promise<UploadedFolder | null> {
    const root = this.rootFor(sid);
    // A folder that arrived whole is already on disk; the marker says so.
    const whole = await this.unpacked(sid);
    if (!atts.length) return whole ? { root, name: whole.name, files: whole.files } : null;
    const strip = commonRoot(atts.map((a) => a.name));
    const seen = this.done.get(sid) ?? new Set<string>();
    this.done.set(sid, seen);
    let count = 0;
    for (const a of atts) {
      const rel = strip && a.name.startsWith(`${strip}/`) ? a.name.slice(strip.length + 1) : a.name;
      // The store already stripped `..` and drive letters from the name; this
      // is the second check, because the first one being enough is the sort of
      // thing that stops being true.
      const full = path.resolve(root, rel);
      if (full !== root && !full.startsWith(root + path.sep)) continue;
      count++;
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if (await stat(full).then(() => true, () => false)) continue;
      const f = await this.files.get(sid, a.id);
      if (!f) continue;
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.data);
    }
    const total = count + (whole?.files ?? 0);
    return total ? { root, name: whole?.name || strip || "the uploaded files", files: total } : null;
  }

  private marker(sid: string) {
    // Beside the folder, not in it: the folder is the person's, and would otherwise gain a file they never wrote.
    return `${this.rootFor(sid)}.upload.json`;
  }

  /** What a whole-folder upload left behind, if one happened. */
  private async unpacked(sid: string): Promise<{ name: string; files: number } | null> {
    try {
      return JSON.parse(await readFile(this.marker(sid), "utf8")) as { name: string; files: number };
    } catch {
      return null;
    }
  }

  /**
   * A whole folder, as one archive, unpacked into the session's working copy.
   *
   * Sent as one file so the whole of it arrives: a folder of five thousand
   * entries as five thousand requests is five thousand chances to lose one,
   * and every one of them used to be an attachment on the message. Every path
   * is checked against the folder it lands in — an archive is somebody else's
   * idea of where files go.
   */
  async unpack(sid: string, archive: Buffer, label: string): Promise<{ name: string; files: number }> {
    const zip = await JSZip.loadAsync(archive);
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length > MAX_FOLDER_FILES) throw new Error(`That folder has ${entries.length} files. A session takes up to ${MAX_FOLDER_FILES}.`);
    const names = entries.map((e) => e.name.replace(/^[\\/]+/, ""));
    const top = commonRoot(names);
    const root = this.rootFor(sid);
    await mkdir(root, { recursive: true });
    let files = 0;
    let bytes = 0;
    for (const e of entries) {
      const clean = e.name.replace(/\\/g, "/").replace(/^[a-zA-Z]:/, "").replace(/^\/+/, "");
      const rel = top && clean.startsWith(`${top}/`) ? clean.slice(top.length + 1) : clean;
      if (!rel || rel.split("/").some((seg) => seg === ".." || seg === "")) continue;
      const full = path.resolve(root, rel);
      if (full === root || !full.startsWith(root + path.sep)) continue;
      const data = await e.async("nodebuffer");
      bytes += data.length;
      if (bytes > MAX_FOLDER_BYTES) throw new Error(`That folder is larger than ${Math.round(MAX_FOLDER_BYTES / 1024 / 1024)} MB unpacked.`);
      try {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, data);
        files++;
      } catch {
        // A name this filesystem will not hold is one file lost, not the folder.
      }
    }
    const before = await this.unpacked(sid);
    const result = { name: before?.name || top || label || "the uploaded folder", files: (before?.files ?? 0) + files };
    await writeFile(this.marker(sid), JSON.stringify(result));
    return { name: result.name, files };
  }

  /** One read, write or search inside the uploaded folder. */
  async read(sid: string, atts: Attachment[], req: RepoCall): Promise<{ output: string; where?: { host: string; cwd: string } } | null> {
    const folder = await this.ensure(sid, atts);
    if (!folder) return null;
    // Said here rather than left to readRepo, whose refusal talks about a
    // machine's mode and a host who can change it — neither of which exists
    // for a folder somebody attached.
    if (req.op === "shell" && !uploadsMayRun()) {
      return {
        output:
          "These files were uploaded to Friday, so there is nowhere here to run them. You can read, search, edit and commit them. To build or test anything, someone in the session can connect their machine from the session header, and the same tools then work in their own checkout.",
      };
    }
    // Every git question gets this folder's own repository — never whatever repository happens to enclose the uploads directory.
    if (GIT_OPS.has(req.op)) await ownRepo(folder.root);
    return {
      output: await readRepo(folder.root, { ...req, mode: modeNow(), isolate: true }),
      where: { host: "the uploaded folder", cwd: folder.name },
    };
  }
}

/**
 * Give an uploaded folder a git repository of its own, so undo works in it.
 *
 * Its own, not whatever encloses it: the uploads directory can sit inside
 * another checkout (in development it is inside this one), and git would
 * otherwise snapshot and restore that whole repository instead.
 */
async function ownRepo(root: string): Promise<void> {
  if (await stat(path.join(root, ".git")).then(() => true, () => false)) return;
  await new Promise<void>((resolve, reject) => execFile("git", ["init", "-q"], { cwd: root, windowsHide: true }, (e) => (e ? reject(e) : resolve())));
}
