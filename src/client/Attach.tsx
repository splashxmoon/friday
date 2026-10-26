import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { ACCEPT_ATTR, isUsableFile } from "../file-kinds.js";
import type { CliSession } from "../runner/imports.js";
import type { FolderInfo } from "../runner/workspace.js";
import type { Attachment, EngineTool } from "../types.js";
import { uploadFile, failureText } from "./api.js";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import { MenuButton } from "./ui.js";
import { WorkspaceCard, type Picked } from "./Workspace.js";

/**
 * Attaching files to the first message.
 *
 * Two ways in, because they are different acts: a few files you name, or a
 * folder you hand over whole. A folder arrives as hundreds of entries — most of
 * them `node_modules`, images the agent can't read, or a `.git` directory — so
 * the ones it cannot use are dropped here and *said*, rather than uploaded and
 * quietly delivered as "binary content not shown".
 */

/**
 * Directories that are generated, not written.
 *
 * Everything here is either a package manager's download cache or a build
 * output directory — things that are reproducible from the files beside them
 * and would otherwise be most of what gets uploaded. Notably absent: `bin`
 * and `out`, which in plenty of projects hold scripts somebody wrote by hand.
 */
const SKIP_DIR = new RegExp(
  `(^|/)(${[
    "node_modules|bower_components|jspm_packages",
    "\\.git|\\.hg|\\.svn",
    "\\.next|\\.nuxt|\\.svelte-kit|\\.astro|\\.angular|\\.expo|\\.serverless|\\.vercel|\\.netlify",
    "\\.venv|venv|__pycache__|\\.pytest_cache|\\.mypy_cache|\\.ruff_cache|\\.tox|site-packages|\\.eggs",
    "dist|build|target|_build|deps|out\\.gradle|\\.gradle|\\.dart_tool|\\.stack-work|elm-stuff",
    "Pods|Carthage|DerivedData|\\.build|xcuserdata",
    "\\.terraform|\\.serverless",
    "\\.turbo|\\.parcel-cache|\\.cache|\\.yarn|\\.pnpm-store|\\.nx",
    "coverage|\\.nyc_output|vendor",
  ].join("|")})(/|$)`,
);
/**
 * How much of a folder actually goes up.
 *
 * Both ceilings are set where a whole ordinary project fits under them,
 * because "most of your folder is attached" is the worst answer to give: a
 * source tree with its build and dependency folders taken out is a few
 * hundred files and tens of megabytes, and it should arrive whole. They are
 * here to stop a folder of video, not to ration a repository.
 */
export const MAX_FILES = 60_000;
/** Formats that are compressed already. */
const PACKED = /.(png|jpe?g|gif|webp|avif|heic|mp4|mov|webm|mkv|mp3|aac|ogg|zip|gz|tgz|7z|rar|woff2?|pdf|ico)$/i;
export const MAX_BYTES = 1024 * 1024 * 1024;
/** A loose file over this is refused by the server; inside a folder there is no such limit. */
export const MAX_ONE = 10 * 1024 * 1024;
export const MAX_ONE_IN_FOLDER = 200 * 1024 * 1024;

export interface Attached {
  file: File;
  /** Path within the folder that was picked, or just the name. */
  path: string;
  /** The picked folder this came from, when it came from one. */
  folder?: string;
}

/** webkitRelativePath is set only when the folder input was used. */
const pathOf = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
/** The top folder a relative path sits under — how chips are grouped. */
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : undefined);

/**
 * What of this pick can actually go, given what is already attached.
 *
 * The room left has to count what is on the composer already, or a folder
 * attached first fills the ceiling and the two files picked after it vanish
 * without a word — which is what used to happen, because the cap was applied
 * to the merged list after the fact rather than to the pick.
 */
export function pickable(files: File[], already: Attached[] = []): { keep: Attached[]; skipped: number; reason: string; over: number } {
  const keep: Attached[] = [];
  let noisy = 0;
  let unreadable = 0;
  let huge = 0;
  let over = 0;
  let bytes = already.reduce((n, a) => n + a.file.size, 0);
  const room = () => MAX_FILES - already.length - keep.length;
  for (const file of files) {
    const path = pathOf(file);
    if (SKIP_DIR.test(path)) {
      noisy++;
      continue;
    }
    // A file picked on its own has to be something the agent can read. Inside a
    // folder everything goes: the images, fonts and data a project is built from
    // are part of it, and a working copy with the pictures missing does not run.
    const inFolder = path.includes("/");
    if (!inFolder && !isUsableFile(path, file.type)) {
      unreadable++;
      continue;
    }
    // The server refuses a loose file this big, so keeping it only trades a
    // message here for a failed upload later.
    if (file.size > (inFolder ? MAX_ONE_IN_FOLDER : MAX_ONE)) {
      huge++;
      continue;
    }
    // Counted, not dropped silently: the difference between "your folder is
    // attached" and "most of your folder is attached" is worth a sentence.
    if (room() <= 0 || bytes + file.size > MAX_BYTES) {
      over++;
      continue;
    }
    bytes += file.size;
    keep.push({ file, path, folder: folderOf(path) });
  }
  const bits: string[] = [];
  if (noisy) bits.push(`${noisy} from build and dependency folders`);
  // Named for what they are. "The agent can't read them" was true of a rule
  // that threw away Dockerfiles; now the only things left here are media,
  // archives and compiled output, and saying so is the difference between a
  // message people can check and one they have to trust.
  if (unreadable) bits.push(`${unreadable} media and binaries`);
  if (huge) bits.push(`${huge} too large`);
  return { keep, skipped: noisy + unreadable + huge, reason: bits.join(", "), over };
}

/** Add to what's already attached, dropping duplicates and saying what it skipped. */
export function attach(files: Attached[], incoming: File[], onChange: (f: Attached[]) => void, onNote: (msg: string) => void): number {
  const { keep, skipped, reason, over } = pickable(incoming, files);
  const merged = [...files];
  for (const k of keep) if (!merged.some((m) => m.path === k.path && m.file.size === k.file.size)) merged.push(k);
  onChange(merged);
  const tail = over ? ` ${over} more didn't fit — remove something to make room, or send them in a later message.` : "";
  if (!keep.length && skipped) onNote(`Nothing to attach: skipped ${reason}.${tail}`);
  else if (!keep.length && over) onNote(`There is no room left for ${over} more file${over === 1 ? "" : "s"}. Remove something, or send them in a later message.`);
  else if (skipped) onNote(`Attached ${keep.length}, skipped ${reason}.${tail}`);
  else if (over) onNote(`Attached ${keep.length}.${tail}`);
  else onNote("");
  return keep.length;
}

/**
 * Sending what was attached, once the session exists to hold it.
 *
 * A folder is hundreds of uploads, and both composers used to do them one
 * after another with no tolerance: file 174 failing threw away the 173 that
 * had already landed and the session started with nothing. So: a few at a
 * time, failures counted rather than fatal, and progress reported, because a
 * folder takes long enough that silence reads as a hang.
 */
export async function uploadAll(
  files: Attached[],
  sid: string,
  invite: string,
  userId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ attachments: Attachment[]; failed: number; folders: { name: string; files: number }[] }> {
  const loose = files.filter((f) => !f.folder);
  const picked = new Map<string, Attached[]>();
  for (const f of files) if (f.folder) picked.set(f.folder, [...(picked.get(f.folder) ?? []), f]);
  const total = loose.length + picked.size;
  let done = 0;
  const step = () => onProgress?.(++done, total);

  // A picked folder goes up as one archive, unpacked whole on the other side:
  // hundreds of requests are hundreds of chances to lose a file, and each one
  // used to be an attachment on the message, of which only ten survived.
  const folders: { name: string; files: number }[] = [];
  let failed = 0;
  for (const [name, list] of picked) {
    try {
      // Fetched here, the first time a folder goes up: a hundred kilobytes nobody else needs to load with the page.
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      // Already-compressed files go in as they are: deflating a photo or a font
      // spends the time and saves nothing, and on a big folder that is most of the wait.
      for (const f of list) zip.file(f.path, f.file, { binary: true, compression: PACKED.test(f.path) ? "STORE" : "DEFLATE" });
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}/folder?invite=${encodeURIComponent(invite)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/zip", "x-folder-name": encodeURIComponent(name) },
        body: blob,
      });
      const body = (await res.json().catch(() => ({}))) as { name?: string; files?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? failureText(res.status));
      folders.push({ name: body.name ?? name, files: body.files ?? list.length });
    } catch {
      failed += list.length;
    }
    step();
  }

  // Files named one by one keep their own path: a handful, a few at a time.
  const landed: (Attachment | null)[] = loose.map(() => null);
  let next = 0;
  const one = async (f: Attached, at: number) => {
    const url = URL.createObjectURL(f.file);
    try {
      landed[at] = await uploadFile(sid, invite, userId, { url, mediaType: f.file.type, filename: f.path });
    } catch {
      failed++;
    } finally {
      URL.revokeObjectURL(url);
      step();
    }
  };
  const workers = Array.from({ length: Math.min(6, loose.length) }, async () => {
    while (next < loose.length) {
      const at = next++;
      await one(loose[at]!, at);
    }
  });
  await Promise.all(workers);
  return { attachments: landed.filter((a): a is Attachment => !!a), failed, folders };
}

/**
 * Pasting a screenshot into the box.
 *
 * A clipboard image arrives as a File called "image.png" every time, so two
 * screenshots in a row would look like the same file and the second would be
 * dropped as a duplicate. They get the time instead, which is also what a
 * person calls them when they talk about them.
 */
export function pasteAttach(files: Attached[], onChange: (f: Attached[]) => void, onNote: (msg: string) => void) {
  return (e: ClipboardEvent<HTMLElement>) => {
    const dropped = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (!dropped.length) return;
    // Only take over the paste once there is something to take: a plain text
    // paste has to keep working.
    e.preventDefault();
    const stamped = dropped.map((f) =>
      f.type.startsWith("image/") && /^(image|screenshot)\.\w+$/i.test(f.name)
        ? new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${f.type.split("/")[1]}`, { type: f.type })
        : f,
    );
    attach(files, stamped, onChange, onNote);
  };
}

/**
 * The plus: everything a run can start from.
 *
 * Files and a folder you hand over, and — from the same menu — the code
 * already on your machine. The folder had its own button beside this one,
 * which asked the same question twice: both of them answer "what is this run
 * about".
 */
/** Asks the composer's attach button for its folder picker (Code.tsx's "Choose folder"). */
export const PICK_FOLDER = "friday:pick-folder";

export function AttachButton({
  files,
  onChange,
  onNote,
  workspace,
}: {
  files: Attached[];
  onChange: (f: Attached[]) => void;
  onNote: (msg: string) => void;
  /** Absent when there is no machine to look on. */
  workspace?: { identity: Identity; tool: EngineTool; resume?: CliSession; onPick: (p: Picked | null) => void; onTool?: (t: EngineTool) => void; onNeedsMachine?: () => void };
}) {
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const plus = useRef<HTMLSpanElement>(null);
  const [picking, setPicking] = useState<"sessions" | "repos" | null>(null);

  const take = (list: FileList | null) => attach(files, Array.from(list ?? []), onChange, onNote);

  // In the desktop app, with this computer connected, a folder is worked in
  // where it is: nothing is zipped, sent or capped, so a folder of any size
  // opens at once — and because it is a real folder on a real machine, the
  // agent can run it and the Preview panel can show it. Uploading is for a
  // browser, which can only hand a folder over as copies of its files.
  const desktop = typeof window !== "undefined" ? window.fridayDesktop : undefined;
  const inPlace = !!desktop?.pickFolder && !!workspace && !workspace.onNeedsMachine;
  const pickInPlace = async () => {
    try {
      const p = await desktop!.pickFolder();
      if (!p) return;
      const r = await hostApi<{ folder: FolderInfo }>(workspace!.identity, `/api/runner/describe?path=${encodeURIComponent(p)}`);
      workspace!.onPick({ folder: r.folder });
      onNote(`Working in ${r.folder.name} on this computer. Nothing is uploaded, so any size works.`);
    } catch (e) {
      onNote(`Couldn't open that folder: ${(e as Error).message}`);
    }
  };
  const openWorkspace = (which: "sessions" | "repos") => () => (workspace?.onNeedsMachine ? workspace.onNeedsMachine() : setPicking(which));
  // "Choose folder" under the box (Code.tsx) opens the same picker as the + menu's Folder, which nobody found behind the +.
  const openRepos = useRef(openWorkspace("repos"));
  openRepos.current = openWorkspace("repos");
  useEffect(() => {
    const on = () => openRepos.current();
    window.addEventListener(PICK_FOLDER, on);
    return () => window.removeEventListener(PICK_FOLDER, on);
  }, []);

  return (
    <>
      <input
        ref={filePicker}
        type="file"
        multiple
        hidden
        accept={ACCEPT_ATTR}
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      {/* webkitdirectory is the only way a browser hands over a folder; it is
          supported everywhere Friday runs, and ignored where it isn't. */}
      <input
        ref={folderPicker}
        type="file"
        hidden
        multiple
        // @ts-expect-error -- not in the DOM types, understood by every browser.
        webkitdirectory=""
        directory=""
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      <span className="cm-anchor" ref={plus}>
        <MenuButton
          className={`icon-btn ${files.length ? "on" : ""}`}
          label="Add"
          icon="plus"
          above
          items={() => [
            // One line each: the names say enough, and a second line under every item was more to read than to choose from.
            { label: "Files", icon: "file", onSelect: () => filePicker.current?.click() },
            // In the desktop app a folder is this computer's, whole and in place. If
            // the computer isn't connected yet that is what gets sorted out first —
            // quietly uploading a trimmed copy instead is how a folder arrived
            // half there, and unable to run. An upload stays one click away.
            ...(desktop?.pickFolder && workspace
              ? ([
                  {
                    label: "Folder",
                    icon: "folder" as const,
                    // Only when it won't do what it says yet: picking it then leads to connecting first.
                    ...(inPlace ? {} : { hint: "connect this computer first" }),
                    onSelect: () => (inPlace ? void pickInPlace() : workspace.onNeedsMachine?.()),
                  },
                  { label: "Upload a copy", icon: "folder" as const, onSelect: () => folderPicker.current?.click() },
                ] as const)
              : // In a browser with a machine connected, a folder is that machine's too, found by browsing it: whole, in place,
                // runnable. Uploading a copy stays one click away.
                workspace && !workspace.onNeedsMachine
                ? ([
                    { label: "Folder", icon: "folder" as const, sub: "On the connected computer", onSelect: openWorkspace("repos") },
                    { label: "Upload a copy", icon: "folder" as const, onSelect: () => folderPicker.current?.click() },
                  ] as const)
                : ([{ label: "Folder", icon: "folder" as const, onSelect: () => folderPicker.current?.click() }] as const)),
            ...(workspace
              ? ([
                  { label: "Sessions", icon: "clock" as const, onSelect: openWorkspace("sessions") },
                  { label: "Repos", icon: "folderOpen" as const, onSelect: openWorkspace("repos") },
                ] as const)
              : []),
          ]}
        />
      </span>
      {picking && workspace && (
        <WorkspaceCard
          identity={workspace.identity}
          tool={workspace.tool}
          trigger={plus.current}
          resume={workspace.resume}
          only={picking}
          onPick={workspace.onPick}
          {...(workspace.onTool ? { onTool: workspace.onTool } : {})}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );
}

/**
 * The chips under the composer: what is going up, and a way to drop one.
 *
 * A folder is one thing a person attached, so it is one chip — not the two
 * hundred files inside it, which is a wall nobody reads and which buries the
 * two files they also picked by hand. The chip says how many it holds, opens
 * to show them, and removing it removes the folder rather than one file of it.
 */
export function AttachedRow({ files, onChange }: { files: Attached[]; onChange: (f: Attached[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (!files.length) return null;

  // Folders in the order they were attached, each keeping its own files.
  const folders = new Map<string, Attached[]>();
  const loose: Attached[] = [];
  for (const f of files) {
    if (f.folder) folders.set(f.folder, [...(folders.get(f.folder) ?? []), f]);
    else loose.push(f);
  }
  const entries = [...folders];
  const drop = (gone: Attached[]) => onChange(files.filter((x) => !gone.includes(x)));
  // Loose files still get the old treatment: a few chips, then a count.
  const shownLoose = all ? loose : loose.slice(0, 6);

  return (
    <div className="attach-row">
      {entries.map(([name, inside]) => (
        <span key={name} className={`attach-chip folder ${open === name ? "on" : ""}`} title={`${name} · ${inside.length} file${inside.length === 1 ? "" : "s"}`}>
          <Icon name="folder" size={13} />
          <button type="button" className="attach-name as-button" onClick={() => setOpen(open === name ? null : name)} aria-expanded={open === name}>
            {name}
            <span className="attach-count">{inside.length}</span>
          </button>
          <button type="button" aria-label={`Remove the folder ${name}`} onClick={() => drop(inside)}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      {shownLoose.map((f) => (
        <span key={f.path} className="attach-chip" title={f.path}>
          <Icon name="file" size={13} />
          <span className="attach-name">{f.path}</span>
          <button type="button" aria-label={`Remove ${f.path}`} onClick={() => drop([f])}>
            <Icon name="x" size={11} />
          </button>
        </span>
      ))}
      {loose.length > shownLoose.length && (
        <button type="button" className="attach-more" onClick={() => setAll(true)}>
          +{loose.length - shownLoose.length} more
        </button>
      )}
      {files.length > 1 && (
        <button type="button" className="attach-more" onClick={() => (onChange([]), setOpen(null), setAll(false))}>
          Clear
        </button>
      )}
      {open && (
        <div className="attach-inside">
          <div className="attach-inside-head">
            {open} · {folders.get(open)?.length} files
          </div>
          <ul>
            {(folders.get(open) ?? []).map((f) => (
              <li key={f.path}>
                <span className="attach-inside-path">{f.path.slice(open.length + 1)}</span>
                <button type="button" aria-label={`Remove ${f.path}`} onClick={() => drop([f])}>
                  <Icon name="x" size={11} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
