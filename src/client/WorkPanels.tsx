/**
 * A Work session's pieces as the rail reads them (WorkRail.tsx): the folder's listing, asked again while anything shows it; a
 * document read as itself (Markdown rendered, a sheet as a sheet, a page working, a PDF); and the pictures large, one at a time.
 * All read the folders the session's agents work in (work-files.ts), as they are now. The side panels these began in (Documents,
 * Media, Sources) went when the rail took their place (Arun, 2026-10-26: "rather than side panels we can have what claude and
 * codex have on their chats").
 *
 */
import { Component, createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ErrorInfo, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Streamdown } from "streamdown";
import { Icon } from "./icons.js";
import { relTime } from "./ui.js";
import { dirOf, fileTitle, fromTop, headingOf, wordCount, inFolderRef, PAGE_REFS, pageRef, frameScope, pieceTitle, plainLine, resolveFrom, sheetRows, workPoller, type Listed } from "./work-outputs.js";
import "./work.css";

export { resolveFrom, sourcesIn, type Source } from "./work-outputs.js";

export interface WorkFile {
  root: number;
  path: string;
  kind: "doc" | "image" | "video" | "audio";
  size: number;
  mtime: number;
  title?: string;
  excerpt?: string;
  words?: number;
  columns?: string[];
  rows?: number;
  frames?: number;
}

const q = (sid: string) => `/api/sessions/${encodeURIComponent(sid)}/work`;
export const fileUrl = (sid: string, invite: string, f: Pick<WorkFile, "root" | "path">) => `${q(sid)}/file?root=${f.root}&path=${encodeURIComponent(f.path)}&invite=${encodeURIComponent(invite)}`;
const fullPath = (roots: string[], f: Pick<WorkFile, "root" | "path">) => `${roots[f.root] ?? ""}/${f.path}`;

/** The session's pieces, asked for again every few seconds while anything shows them: the agents keep adding to them. */
export type WorkList = { roots: string[]; files: WorkFile[]; error: string; loaded: boolean };
const NONE: WorkList = { roots: [], files: [], error: "", loaded: false };
/** One asking per session, however many things show it (the rail, the footer's counts); one at a time (work-outputs.ts workPoller). */
const lists = new Map<string, { poll: ReturnType<typeof workPoller>; subs: Set<() => void>; timer: number; invite: string }>();

function listFor(sid: string, invite: string) {
  let at = lists.get(sid);
  if (!at) {
    const subs = new Set<() => void>();
    const entry = { subs, timer: 0, invite } as { poll: ReturnType<typeof workPoller>; subs: Set<() => void>; timer: number; invite: string };
    entry.poll = workPoller(
      async () => {
        const r = await fetch(`${q(sid)}?invite=${encodeURIComponent(entry.invite)}`);
        const body = (await r.json().catch(() => ({}))) as Listed;
        if (!r.ok) throw new Error(body.error || `The folder couldn't be read (${r.status}).`);
        return body;
      },
      () => subs.forEach((f) => f()),
    );
    lists.set(sid, (at = entry));
  }
  at.invite = invite;
  return at;
}

export function useWork(sid: string, invite: string, shown: boolean): WorkList {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!shown) return;
    const list = listFor(sid, invite);
    const heard = () => bump((n) => n + 1);
    list.subs.add(heard);
    if (!list.timer) {
      void list.poll.look();
      list.timer = window.setInterval(() => void list.poll.look(), 4000);
    }
    return () => {
      list.subs.delete(heard);
      if (!list.subs.size) (window.clearInterval(list.timer), (list.timer = 0));
    };
  }, [sid, invite, shown]);
  return lists.get(sid)?.poll.get() ?? NONE;
}

/** The folder read again now, not at the next tick: a file an agent wrote a moment ago, named in the chat before the list had it. */
export const refreshWork = (sid: string, invite: string): Promise<WorkList> => {
  const at = listFor(sid, invite);
  return at.poll.look(true).then(() => at.poll.get());
};

export const name = (p: string) => p.split("/").pop() ?? p;
export const ext = (p: string) => (p.split(".").pop() ?? "").toLowerCase();
/** What a piece can be read as here: rendered, as plain text, as a PDF, or only opened in its own app. */
export const readAs = (p: string): "md" | "csv" | "text" | "pdf" | "page" | "app" => (["md", "markdown"].includes(ext(p)) ? "md" : ext(p) === "csv" ? "csv" : ext(p) === "html" ? "page" : ["txt", "rtf"].includes(ext(p)) ? "text" : ext(p) === "pdf" ? "pdf" : "app");

type Tried = { ok: boolean; error?: string };
const said = (r: Tried | undefined, or: string) => (r?.ok ? "" : r?.error || or);

/** A piece in the app this computer opens it with; what went wrong, or "" when it opened. */
export async function openOutside(roots: string[], f: Pick<WorkFile, "root" | "path">): Promise<string> {
  const d = window.fridayDesktop;
  const at = fullPath(roots, f);
  if (d?.openFile) return said(await d.openFile(at).catch((e: Error) => ({ ok: false, error: e.message })), "It couldn't be opened.");
  if (d?.openIn) return said(await d.openIn("files", at).catch((e: Error) => ({ ok: false, error: e.message })), "It couldn't be shown.");
  return "This kind of file opens in its own app, from the Friday desktop app.";
}

/**
 * A folder in Finder (or the system's file manager): through "Open in"'s Files, which opens a folder where openFile only opens
 * files, and said when it can't (Arun, 2026-10-28: "iron everything and ensure we are good… focusing on UI and UX and any logic
 * errors"). Every folder button pressed did nothing before.
 */
export async function showFolder(dir: string): Promise<string> {
  const d = window.fridayDesktop;
  if (!dir) return "There's no folder yet.";
  if (!d?.openIn) return "Folders open from the Friday desktop app.";
  return said(await d.openIn("files", dir).catch((e: Error) => ({ ok: false, error: e.message })), "That folder couldn't be shown.");
}

/** What a press that reaches outside the app said went wrong, for a few seconds: [the words, run it]. */
export function useTried(): [string, (p: Promise<string>) => void] {
  const [err, setErr] = useState("");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [
    err,
    (p) =>
      void p.then((e) => {
        window.clearTimeout(timer.current);
        setErr(e);
        if (e) timer.current = window.setTimeout(() => setErr(""), 5000);
      }),
  ];
}

/** A reader that failed to draw what it was given: says so, with a way back, instead of taking the whole app down with it. */
export class ReaderGuard extends Component<{ onBack: () => void; children: ReactNode; reset: string }, { failed: string; at: string }> {
  state = { failed: "", at: this.props.reset };
  static getDerivedStateFromError(e: Error) {
    return { failed: e.message || "Something in it couldn't be drawn." };
  }
  static getDerivedStateFromProps(p: { reset: string }, s: { failed: string; at: string }) {
    return p.reset !== s.at ? { failed: "", at: p.reset } : null;
  }
  componentDidCatch(e: Error, info: ErrorInfo) {
    console.warn("[work reader]", e, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="work-doc">
        <div className="work-empty" role="alert">
          <Icon name="file" size={20} />
          <b>This one couldn't be shown here</b>
          <span>{this.state.failed}</span>
          <button type="button" className="btn small" onClick={this.props.onBack}>
            <Icon name="arrowLeft" size={13} />
            Back
          </button>
        </div>
      </div>
    );
  }
}

/** The folder all of these are in, when they share one: `outputs/friday-studio` for its files and its subfolders'. */
export function commonDir(paths: string[]): string {
  if (!paths.length) return "";
  const dirs = paths.map((p) => p.split("/").slice(0, -1));
  const first = dirs[0]!;
  let n = first.length;
  for (const d of dirs) {
    let i = 0;
    while (i < n && d[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}

/** The folder a piece is in, below the one they all share. */
export const subDir = (p: string, top: string) => {
  const dir = p.split("/").slice(0, -1).join("/");
  return (top && dir.startsWith(top) ? dir.slice(top.length) : dir).replace(/^\//, "");
};

/** A CSV as rows of cells: quoted cells, doubled quotes and line breaks inside quotes as a spreadsheet writes them. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((x) => x.trim()));
}

/** What kind of file, as a short mark and its colour. */
export const MARK: Record<string, string> = { md: "md", markdown: "md", txt: "txt", csv: "csv", pdf: "pdf", docx: "doc", pptx: "ppt", xlsx: "xls", html: "web", rtf: "txt" };

/** A piece's own title: its first heading, else its name without the extension. */
export const titleOf = (text: string | null, file: string) => {
  const heading = headingOf(text ?? "");
  if (heading && plainLine(heading)) return plainLine(heading);
  // shot-plan.csv → Shot plan; 02_art_direction.md → Art direction.
  return fileTitle(file);
};

/** What a document's links and pictures need to know: kept in a context, so the renderer's parts never change and never remount. */
type DocLinks = { files: WorkFile[]; root: number; open: (f: WorkFile) => void; picture: (path: string) => string };
const DocCtx = createContext<DocLinks>({ files: [], root: 0, open: () => {}, picture: (p) => p });

/** A heading's place in a document, for its table of contents: "## Second heading" is #second-heading (w2 #8). */
export const slugOf = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
const textOf = (n: ReactNode): string => (typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" && "props" in n ? textOf((n as { props: { children?: ReactNode } }).props.children) : "");
/** The document's headings, each with its id, prefixed so it never meets one of the app's own. */
const docHeading =
  (Tag: "h1" | "h2" | "h3" | "h4") =>
  ({ children }: { children?: ReactNode }) => <Tag id={`doc-${slugOf(textOf(children))}`}>{children}</Tag>;

/** A link in a document: to a piece beside it, opened here; to a heading in it, scrolled to; to the web, in the browser. */
function DocLink({ href, children }: { href?: string; children?: ReactNode }) {
  const c = useContext(DocCtx);
  const to = href ?? "";
  // A heading it points to that the piece doesn't have: said beside the link once pressed, not a press that did nothing (QA,
  // 2026-10-28; Arun: "TEST EVERYTHING… EVERY INTERACTION").
  const [nowhere, setNowhere] = useState(false);
  const local = to.startsWith("/") ? c.files.find((f) => f.root === c.root && f.path === resolveFrom("", to)) : undefined;
  // A piece it names that isn't in the folder says so where it is, rather than a link that does nothing (w2 #9).
  if (to.startsWith("/") && !local && /\.[a-z0-9]{1,5}$/i.test(to.split(/[?#]/)[0]!))
    return (
      <span className="doc-link missing" title={`${safeName(to)} isn't in the folder`}>
        {children}
        <em> (not in the folder)</em>
      </span>
    );
  const go = (e: MouseEvent) => {
    e.preventDefault();
    if (local) return c.open(local);
    if (to.startsWith("#")) {
      const id = (() => {
        try {
          return decodeURIComponent(to.slice(1));
        } catch {
          return to.slice(1);
        }
      })();
      const at = (e.currentTarget as HTMLElement).closest(".work-prose");
      const target = at?.querySelector<HTMLElement>(`[id="doc-${CSS.escape(slugOf(id))}"]`) ?? at?.querySelector<HTMLElement>(`[id="doc-${CSS.escape(id)}"]`);
      if (!target) return setNowhere(true);
      return void target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    if (/^https?:/i.test(to)) window.fridayDesktop?.openExternal ? void window.fridayDesktop.openExternal(to) : void window.open(to, "_blank", "noopener");
  };
  return (
    <>
      <a href={to} onClick={go} className={local ? "doc-link local" : "doc-link"} title={local ? `Open ${local.path}` : to}>
        {local && <Icon name="file" size={12} />}
        {children}
      </a>
      {nowhere && (
        <em className="doc-link-note" role="status">
          {" "}
          (no such heading in this piece)
        </em>
      )}
    </>
  );
}

const safeName = (p: string) => {
  try {
    return name(decodeURIComponent(p));
  } catch {
    return name(p);
  }
};

/** A picture in a document: one beside it comes from the folder. Its room kept before it arrives, so the words under it don't
 *  jump down when a large one lands (w2 #15). */
function DocImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const c = useContext(DocCtx);
  const at = typeof src === "string" ? src : "";
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  // One from the web is fetched only when asked: a picture in an agent's document loaded from anywhere told that site the piece
  // was read (QA, 2026-10-28). One that doesn't come says which, not the browser's broken-picture mark.
  const remote = /^https?:\/\//i.test(at);
  const [allowed, setAllowed] = useState(false);
  const what = alt?.trim() || safeName(at.split(/[?#]/)[0] ?? at) || "A picture";
  if (remote && !allowed) {
    const host = (() => {
      try {
        return new URL(at).hostname.replace(/^www\./, "");
      } catch {
        return "the web";
      }
    })();
    return (
      <span className="doc-img-off">
        <Icon name="image" size={14} />
        <span>
          {what} <em>from {host}</em>
        </span>
        <button type="button" className="link-btn" onClick={() => setAllowed(true)} title={`Loads it from ${host}, which then knows it was viewed`}>
          Show it
        </button>
      </span>
    );
  }
  if (failed)
    return (
      <span className="doc-img-off" role="img" aria-label={`${what}: couldn't be shown`}>
        <Icon name="image" size={14} />
        <span>
          {what} <em>{remote ? "didn't load" : "isn't in the folder"}</em>
        </span>
      </span>
    );
  return <img className={loaded ? "doc-img" : "doc-img waiting"} src={at.startsWith("/") ? c.picture(resolveFrom("", at)) : at} alt={alt ?? ""} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => (setLoaded(true), setFailed(true))} />;
}

/**
 * The renderer's parts, made once: made again on every render (the folder's listing every four seconds, every live event), React
 * took each for a new kind of element and remounted every link and picture in the open document, which flickered, reloaded its
 * pictures and lost the reader's selection (Arun, 2026-10-28: "iron everything and ensure we are good… focusing on UI and UX").
 */
const DOC_PARTS = { a: DocLink, img: DocImage, h1: docHeading("h1"), h2: docHeading("h2"), h3: docHeading("h3"), h4: docHeading("h4") };

export function DocView({ sid, invite, roots, file, files, onOpen, onBack, back = "All documents" }: { sid: string; invite: string; roots: string[]; file: WorkFile; files: WorkFile[]; onOpen: (f: WorkFile) => void; onBack: () => void; back?: string }) {
  const as = readAs(file.path);
  const url = fileUrl(sid, invite, file);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const [copied, setCopied] = useState(false);
  const [outside, tryOutside] = useTried();
  // Read again whenever it changes on disk: an agent still editing it is seen editing it. A file gone or refused says so, never
  // shows the server's refusal as if it were the document.
  useEffect(() => {
    if (as === "pdf") return;
    let gone = false;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "It isn't in the folder any more." : `It couldn't be read (${r.status}).`);
        return r.text();
      })
      .then((t) => {
        if (gone) return;
        setText(t);
        setFailed("");
      })
      .catch((e: Error) => !gone && setFailed(e.message || "It couldn't be read."));
    return () => {
      gone = true;
    };
  }, [url, file.mtime, as]);
  const n = text !== null && as === "md" ? wordCount(text) : 0;
  const opener = useRef(onOpen);
  opener.current = onOpen;
  const open = useCallback((f: WorkFile) => opener.current(f), []);
  const links = useMemo<DocLinks>(() => ({ files, root: file.root, open, picture: (path) => fileUrl(sid, invite, { root: file.root, path }) }), [files, file.root, open, sid, invite]);
  const source = useMemo(() => (as === "md" ? fromTop(text ?? "", file.path) : ""), [as, text, file.path]);
  const rows = useMemo(() => (as === "csv" && text !== null ? csvRows(text) : []), [as, text]);
  const onPath = useCallback((to: string) => {
    const at = files.find((f) => f.root === file.root && f.path === resolveFrom(file.path, to));
    if (at) open(at);
  }, [files, file.root, file.path, open]);
  const has = useCallback((to: string) => files.some((f) => f.root === file.root && f.path === resolveFrom(file.path, to)), [files, file.root, file.path]);
  // The piece by its title, never its file name (the 2026-10-28 critique: the rail said "Launch week content calendar", the
  // reader `launch-week-calendar.html`): what it is, how long, when. The file is in the tooltip and one press from its folder.
  const title = as === "md" || as === "text" ? (text !== null ? titleOf(text, file.path) : file.title ? plainLine(file.title) : fileTitle(file.path)) : file.title ? plainLine(file.title) : fileTitle(file.path);
  const kindWord = as === "page" ? "Page" : as === "csv" ? "Sheet" : as === "pdf" ? "PDF" : "Writing";
  const ago = relTime(file.mtime) === "now" ? "now" : /^\d+\s*[a-z]+$/i.test(relTime(file.mtime)) ? `${relTime(file.mtime)} ago` : relTime(file.mtime);
  // Copy says what lands on the clipboard: the words of a piece of writing, a sheet's cells (ready to paste into a spreadsheet).
  const copyAs = as === "md" || as === "text" ? { label: "Copy text", tip: "Copy the text, ready to paste", value: () => text ?? "" } : as === "csv" ? { label: "Copy table", tip: "Copy the table, ready to paste into a spreadsheet", value: () => rows.map((r) => r.join("\t")).join("\n") } : null;
  const copy = () =>
    copyAs &&
    void navigator.clipboard.writeText(copyAs.value()).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  const [shown, tryShow] = useTried();
  const folder = `${roots[file.root] ?? ""}${dirOf(file.path) ? `/${dirOf(file.path)}` : ""}`;
  const backBtn = useRef<HTMLButtonElement>(null);
  // The keyboard lands on the way back as a piece opens, not on the page's body (w2 #16).
  useEffect(() => backBtn.current?.focus({ preventScroll: true }), []);
  return (
    <div className="work-doc">
      <div className="work-doc-head">
        <button ref={backBtn} type="button" className="icon-btn" onClick={onBack} aria-label={back} title={back}>
          <Icon name="arrowLeft" size={15} />
        </button>
        <span className="work-doc-title" title={file.path}>
          <b>{title}</b>
          <span>
            {kindWord}
            {n ? ` · ${n.toLocaleString()} words · ${Math.max(1, Math.round(n / 230))} min` : ""}
            {as === "csv" && rows.length ? ` · ${(rows.length - 1).toLocaleString()} rows` : ""} · edited {ago}
          </span>
        </span>
        {copyAs && (
          <button type="button" className="btn small" onClick={copy} disabled={!text} title={copyAs.tip}>
            <Icon name={copied ? "check" : "copy"} size={13} />
            <span>{copied ? "Copied" : copyAs.label}</span>
          </button>
        )}
        <a className="icon-btn" href={url} download={name(file.path)} title={`Download ${name(file.path)}`} aria-label={`Download ${name(file.path)}`}>
          <Icon name="download" size={15} />
        </a>
        <button type="button" className={`icon-btn${shown ? " tried-fail" : ""}`} onClick={() => tryShow(showFolder(folder))} title={shown || `Show ${name(file.path)} in its folder`} aria-label="Show in folder">
          <Icon name="folderOpen" size={15} />
        </button>
        <button type="button" className={`btn small${outside ? " tried-fail" : ""}`} onClick={() => tryOutside(openOutside(roots, file))} title={outside || "Open it in the app this computer uses for it"}>
          <Icon name="external" size={13} />
          <span aria-live="polite">{outside || "Open"}</span>
        </button>
      </div>
      {failed && text === null ? (
        <div className="work-empty" role="alert">
          <Icon name="file" size={20} />
          <b>This file couldn't be read</b>
          <span>{failed}</span>
        </div>
      ) : as === "pdf" ? (
        <iframe className="work-doc-frame" src={url} title={name(file.path)} />
      ) : as === "page" ? (
        text !== null && <PageFrame html={text} sid={sid} invite={invite} file={file} />
      ) : (
        <div className={`work-doc-scroll${as === "csv" ? " sheet-host" : ""}`}>
          {failed && <p className="work-doc-stale" role="status">{failed} What shows is the last of it that was read.</p>}
          {as === "md" ? (
            <article className="work-prose">
              {/* Its name as its title only where no heading of its own is one, which would then be said twice. */}
              {text !== null && !headingOf(text) && <h1 className="work-prose-title">{titleOf(text, file.path)}</h1>}
              <DocCtx.Provider value={links}>
                <Streamdown mode="static" parseIncompleteMarkdown={false} controls={false} components={DOC_PARTS}>
                  {source}
                </Streamdown>
              </DocCtx.Provider>
            </article>
          ) : as === "csv" ? (
            <Sheet title={titleOf(null, file.path)} rows={rows} onPath={onPath} has={has} />
          ) : (
            <pre className="work-prose work-doc-text">{text}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const PATHISH = /^[\w./ -]+\.(md|markdown|csv|html|txt|pdf|png|jpe?g|webp|gif|svg|mp4|mov|webm|mp3|wav|m4a)$/i;
/** A column's name as a heading: content_id is "Content id". */
const heading = (h: string) => {
  const w = h.replace(/[_-]+/g, " ").trim();
  return w ? w[0]!.toUpperCase() + w.slice(1) : h;
};

/** As many of a sheet's rows as are drawn at once: a 50,000-row export would otherwise draw every one and freeze the reader. */
const SHEET_CAP = 500;

/**
 * A table the agents keep (a content queue, a shot list), set as a sheet: its header and first column held while it scrolls, each
 * column as wide as what is in it reads well, a column of a few repeated words (status, format, owner) as coloured tags, a file it
 * names as a link to that file, an empty cell as a dash; found by what it says. The first 500 matching rows are drawn.
 */
/** A column whose every value is a number, an amount or a percentage. */
export function numericColumn(vals: string[]): boolean {
  const set = vals.map((v) => v.trim()).filter(Boolean);
  return set.length > 0 && set.every((v) => /^[-+−]?[$€£¥]?\d[\d,  ]*(\.\d+)?\s?(%|[kKmMbB])?$/.test(v));
}

const Sheet = memo(function Sheet({ title, rows, onPath, has }: { title: string; rows: string[][]; onPath: (to: string) => void; has: (to: string) => boolean }) {
  const [find, setFind] = useState("");
  const head = rows[0] ?? [];
  const body = useMemo(() => rows.slice(1), [rows]);
  const cols = head.length || Math.max(0, ...body.map((r) => r.length));
  // A column of a few short values said over and over is a set of tags: each value its own colour, the same wherever it is.
  const tags = useMemo(() => {
    const out: (Map<string, number> | null)[] = [];
    for (let j = 0; j < cols; j++) {
      const vals = body.map((r) => (r[j] ?? "").trim()).filter(Boolean);
      const distinct = [...new Set(vals)];
      const named = /status|state|stage|format|type|kind|priority|owner|channel|platform|audience|gate/i.test(head[j] ?? "");
      const short = vals.every((v) => v.length <= 26 && !PATHISH.test(v));
      out.push(vals.length >= 2 && short && distinct.length <= 6 && (named || distinct.length < vals.length) ? new Map(distinct.map((v, i) => [v, i % 6])) : null);
    }
    return out;
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  // Each row keeps its own number while found: worked out once, not by looking each row up again in the whole sheet.
  const shown = useMemo(() => sheetRows(body, find, SHEET_CAP), [body, find]);
  // A column of numbers reads by its digits: to the right, each digit the same width (QA, 2026-10-28; Arun: "TEST EVERYTHING… EVERY
  // VISUAL").
  const nums = useMemo(() => Array.from({ length: cols }, (_, j) => numericColumn(body.map((r) => r[j] ?? ""))), [body, cols]);
  // A sheet wider than the reader says there is more to the right with its edge fading, not only with a scrollbar.
  const scroller = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => (el.removeEventListener("scroll", check), ro.disconnect());
  }, [rows]);
  return (
    <div className="sheet">
      <div className="sheet-top">
        <span className="sheet-title">
          <b>{title}</b>
          <span>
            {body.length} {body.length === 1 ? "row" : "rows"} · {cols} {cols === 1 ? "column" : "columns"}
          </span>
        </span>
        <label className="docs-find sheet-find">
          <Icon name="search" size={13} />
          <input value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => e.key === "Escape" && find && (e.stopPropagation(), e.preventDefault(), setFind(""))} placeholder="Find in the table" spellCheck={false} aria-label="Find in the table" />
        </label>
      </div>
      <div className={`sheet-scroll${more ? " more" : ""}`} ref={scroller}>
        <table>
          <thead>
            <tr>
              <th className="sheet-n">#</th>
              {Array.from({ length: cols }, (_, j) => (
                <th key={j} title={head[j]} className={j === 0 ? "sheet-key" : nums[j] ? "num" : ""}>
                  {heading(head[j] ?? "")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.rows.map(({ cells: r, at }) => (
              <tr key={at}>
                <td className="sheet-n">{at + 1}</td>
                {Array.from({ length: cols }, (_, j) => {
                  const v = (r[j] ?? "").trim();
                  const tag = tags[j]?.get(v);
                  return (
                    <td key={j} className={`${j === 0 ? "sheet-key" : nums[j] ? "num" : ""}${v.length > 60 ? " long" : ""}`}>
                      {!v ? (
                        <span className="sheet-none">—</span>
                      ) : tag !== undefined ? (
                        <span className={`sheet-tag t${tag}`}>{v}</span>
                      ) : PATHISH.test(v) && has(v) ? (
                        <button type="button" className="sheet-file" onClick={() => onPath(v)} title={`Open ${v}`}>
                          <Icon name="file" size={11} />
                          {name(v)}
                        </button>
                      ) : PATHISH.test(v) ? (
                        <code className="sheet-path">{v}</code>
                      ) : /^https?:\/\//i.test(v) ? (
                        <a className="sheet-link" href={v} onClick={(e) => (e.preventDefault(), window.fridayDesktop?.openExternal ? void window.fridayDesktop.openExternal(v) : void window.open(v, "_blank", "noopener"))}>
                          {v.replace(/^https?:\/\/(www\.)?/i, "")}
                        </a>
                      ) : (
                        v
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.total && <p className="docs-none">Nothing in the table matches “{find.trim()}”.</p>}
        {shown.total > shown.rows.length && (
          <p className="docs-none">
            The first {shown.rows.length.toLocaleString()} of {shown.total.toLocaleString()} rows. Find narrows them; Open shows the whole sheet in its own app.
          </p>
        )}
      </div>
    </div>
  );
});

/** Where the pages agents make may load their scripts, styles and fonts from: the common public CDNs, nothing else. */
const PAGE_CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com";

/**
 * A page an agent made (a one-pager, a dashboard, an explainer), working, as an artifact: drawn from its text in a frame with no
 * origin of its own, so it can run its scripts but never reach the app, the session or the network beyond the CDNs above. What it
 * links to beside it in the folder (its pictures, its video) comes from the folder by a pass of its own (work-frame.ts): good for
 * an hour, for that one folder, for pictures, video and sound only. Never the session's invite, which the page's scripts could
 * read off its own pictures and send anywhere (Arun, 2026-10-28: "iron everything and ensure we are good… any logic errors").
 * No popups, and in the desktop app no leaving for another address (desktop.ts).
 */
export function PageFrame({ html, sid, invite, file }: { html: string; sid: string; invite: string; file: Pick<WorkFile, "root" | "path"> }) {
  const dir = useMemo(() => frameScope(file.path, html), [file.path, html]);
  const needs = useMemo(() => [...html.matchAll(PAGE_REFS)].some((m) => inFolderRef(m[3]!)), [html]);
  const [pass, setPass] = useState<{ dir: string; token: string } | null>(null);
  useEffect(() => {
    if (!needs) return;
    let gone = false;
    fetch(`${q(sid)}/frame-token?invite=${encodeURIComponent(invite)}&root=${file.root}&dir=${encodeURIComponent(dir)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ token?: string }>) : { token: "" }))
      .then((r) => !gone && setPass({ dir, token: r.token ?? "" }))
      .catch(() => !gone && setPass({ dir, token: "" }));
    return () => {
      gone = true;
    };
  }, [needs, sid, invite, file.root, dir]);
  const token = !needs ? "" : pass?.dir === dir ? pass.token : null;
  const doc = useMemo(() => {
    if (token === null) return "";
    const here = (to: string) => (!inFolderRef(to) ? to : token ? `${q(sid)}/framed?t=${encodeURIComponent(token)}&path=${encodeURIComponent(pageRef(file.path, to))}` : "about:blank");
    const linked = html.replace(PAGE_REFS, (_, at: string, qt: string, to: string) => `${at}=${qt}${here(to)}${qt}`);
    const own = location.origin;
    const rules = `default-src 'none'; script-src 'unsafe-inline' ${PAGE_CDNS}; style-src 'unsafe-inline' ${PAGE_CDNS} https://fonts.googleapis.com; font-src https://fonts.gstatic.com ${PAGE_CDNS} data:; img-src ${own} data: blob:; media-src ${own} data: blob:; connect-src 'none'; form-action 'none'`;
    const meta = `<meta http-equiv="Content-Security-Policy" content="${rules}">`;
    // First in the page, so nothing in it runs before the rules do; after a doctype, so it keeps its own layout mode.
    const doctype = /^\s*<!doctype[^>]*>/i.exec(linked)?.[0] ?? "";
    return doctype + meta + linked.slice(doctype.length);
  }, [html, sid, token, file.path]);
  if (token === null) return <div className="work-page-frame work-page-wait" aria-busy="true" />;
  return <iframe className="work-page-frame" srcDoc={doc} sandbox="allow-scripts" referrerPolicy="no-referrer" title={name(file.path)} />;
}

/**
 * A video's first frame as its thumbnail, asked of the folder only once it is near the screen: a gallery of 400 outputs no longer
 * opens every video in it at once (Arun, 2026-10-28: "iron everything and ensure we are good").
 */
export function LazyVideo({ src, className }: { src: string; className?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    if (typeof IntersectionObserver === "undefined") return setNear(true);
    const io = new IntersectionObserver((seen) => seen.some((s) => s.isIntersecting) && setNear(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return <video ref={ref} className={className} src={near ? `${src}#t=0.1` : undefined} preload={near ? "metadata" : "none"} muted playsInline />;
}

/** A folder's media as the panel shows it: videos first, pictures (a numbered run as one set), then sounds as rows. */
interface MediaFolder {
  dir: string;
  mtime: number;
  videos: WorkFile[];
  items: { key: string; label: string; file?: WorkFile; set?: WorkFile[] }[];
  /** Every picture in it, sets opened out, in order: what the gallery steps through. */
  stills: WorkFile[];
  pictures: number;
  sounds: WorkFile[];
}

/** A picture's name with its numbers taken out: the pictures of a run (pilot-f000-v002, pilot-f045-v002…) share it. */
export const runOf = (p: string) => name(p).replace(/\d+/g, "#");

export function mediaFolders(files: WorkFile[], top: string): MediaFolder[] {
  const byDir = new Map<string, WorkFile[]>();
  for (const f of files) {
    const dir = f.kind === "audio" ? soundDir(f.path, top) : subDir(f.path, top);
    byDir.set(dir, [...(byDir.get(dir) ?? []), f]);
  }
  const out: MediaFolder[] = [];
  for (const [dir, fs] of byDir) {
    const order = (a: WorkFile, b: WorkFile) => name(a.path).localeCompare(name(b.path), undefined, { numeric: true });
    const pics = fs.filter((f) => f.kind === "image").sort(order);
    const runs = new Map<string, WorkFile[]>();
    for (const f of pics) runs.set(runOf(f.path), [...(runs.get(runOf(f.path)) ?? []), f]);
    const items: MediaFolder["items"] = [];
    const placed = new Set<string>();
    for (const f of pics) {
      const key = runOf(f.path);
      const run = runs.get(key)!;
      // Four or more pictures differing only by their numbers are one set; fewer stay apart.
      if (run.length >= 4 && /#/.test(key)) {
        if (placed.has(key)) continue;
        placed.add(key);
        // Named for what its pictures share up to their first number: pilot-f000-v002 … pilot-f610-v002 is "pilot-f…".
        const stem = name(run[0]!.path).replace(/\.[a-z0-9]+$/i, "");
        const share = stem.slice(0, stem.search(/\d/));
        items.push({ key, label: `${share.replace(/[-_ ]+$/, "") || stem}…`, set: run });
      } else items.push({ key: f.path, label: name(f.path), file: f });
    }
    out.push({
      dir,
      mtime: Math.max(...fs.map((f) => f.mtime)),
      videos: fs.filter((f) => f.kind === "video").sort(order),
      items,
      stills: items.flatMap((it) => it.set ?? (it.file ? [it.file] : [])),
      pictures: pics.length,
      sounds: fs.filter((f) => f.kind === "audio").sort(order),
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Sounds gather a level up from folders that hold only them (a take per voice in candidates/<voice>/), so they read as one list. */
function soundDir(p: string, top: string): string {
  const dir = subDir(p, top);
  const parts = dir.split("/");
  return parts.length > 2 && /candidates|takes|stems|voices?/i.test(parts[parts.length - 2]!) ? parts.slice(0, -2).join("/") : dir;
}

/**
 * Pictures one at a time, large: ← and → (or the strip) to step through them, Esc to close. Drawn over the whole window rather
 * than inside the rail, whose own layer (docked on a Mac, or full width when narrow) let the side rail and the header paint over
 * it; the keyboard stays in it while it is open, and goes back where it was when it closes.
 */
const sizeWord = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} bytes`);

/**
 * The one picture viewer (the 2026-10-28 critique: "there are two viewers"): its title, what it is and how big on the left; Copy,
 * Download, Show in folder and Close on the right; arrows and the strip when there are two or more; Esc closes it.
 */
export function Gallery({ files, at: start, url, onClose, roots = [] }: { files: WorkFile[]; at: number; url: (f: WorkFile) => string; onClose: () => void; roots?: string[] }) {
  const [at, setAt] = useState(Math.max(0, start));
  const [copied, setCopied] = useState("");
  const [shown, tryShow] = useTried();
  const box = useRef<HTMLDivElement>(null);
  const shut = useRef<HTMLButtonElement>(null);
  const i = Math.min(at, Math.max(0, files.length - 1));
  const f = files[i];
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    shut.current?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), onClose());
      if (e.key === "ArrowRight") setAt((n) => Math.min(files.length - 1, n + 1));
      if (e.key === "ArrowLeft") setAt((n) => Math.max(0, n - 1));
      // The first and the last, as in any viewer (QA, 2026-10-28: they did nothing).
      if (e.key === "Home") (e.preventDefault(), setAt(0));
      if (e.key === "End") (e.preventDefault(), setAt(files.length - 1));
      if (e.key === "Tab" && box.current) {
        const all = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]")];
        if (!all.length) return;
        const first = all[0]!;
        const last = all[all.length - 1]!;
        if (!box.current.contains(document.activeElement)) (e.preventDefault(), first.focus());
        else if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [files.length, onClose]);
  if (!f) return null;
  // The picture itself on the clipboard where the browser can put one there (PNG), else its address.
  const copy = () =>
    void fetch(url(f))
      .then((r) => r.blob())
      .then((b) => (b.type === "image/png" && typeof ClipboardItem !== "undefined" ? navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]) : Promise.reject(new Error("not a png"))))
      .then(
        () => "Copied",
        () => navigator.clipboard.writeText(`${roots[f.root] ? `${roots[f.root]}/` : ""}${f.path}`).then(() => "Copied its path", () => "Couldn't copy it"),
      )
      .then((said) => {
        setCopied(said);
        window.setTimeout(() => setCopied(""), 1600);
      });
  const where = roots[f.root] ? `${roots[f.root]}${dirOf(f.path) ? `/${dirOf(f.path)}` : ""}` : "";
  return createPortal(
    <div ref={box} className="gallery" role="dialog" aria-modal="true" aria-label={`Pictures: ${pieceTitle(f)}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gallery-head">
        <span className="gallery-title" title={f.path}>
          <b>{pieceTitle(f)}</b>
          <em>
            Picture{f.size ? ` · ${sizeWord(f.size)}` : ""}
            {files.length > 1 ? ` · ${i + 1} of ${files.length}` : ""}
          </em>
        </span>
        <span className="gallery-acts">
          {/* Its tip says what it does where it is only an icon (a narrow window); Download and Show in folder have theirs. */}
          <button type="button" className="gallery-act" onClick={copy} aria-live="polite" title={copied || "Copy the picture"}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            <span>{copied || "Copy"}</span>
          </button>
          <a className="gallery-act" href={url(f)} download={name(f.path)} title={`Download ${name(f.path)}`}>
            <Icon name="download" size={14} />
            <span>Download</span>
          </a>
          {where && (
            <button type="button" className={`gallery-act${shown ? " tried-fail" : ""}`} onClick={() => tryShow(showFolder(where))} title={shown || "Show it in its folder"}>
              <Icon name="folderOpen" size={14} />
              <span>{shown || "Show in folder"}</span>
            </button>
          )}
          <button ref={shut} type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="x" size={16} />
          </button>
        </span>
      </div>
      <div className="gallery-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {/* Both stay at the ends, only unpressable: gone at the last picture, a quick second press of Next landed on the backdrop
            and closed the viewer (QA, 2026-10-28). */}
        {files.length > 1 && (
          <button type="button" className="gallery-nav prev" onClick={() => setAt(i - 1)} aria-label="Previous" disabled={i === 0}>
            <Icon name="arrowLeft" size={18} />
          </button>
        )}
        <img src={url(f)} alt={pieceTitle(f)} />
        {files.length > 1 && (
          <button type="button" className="gallery-nav next" onClick={() => setAt(i + 1)} aria-label="Next" disabled={i === files.length - 1}>
            <Icon name="arrowRight" size={18} />
          </button>
        )}
      </div>
      {files.length > 1 && (
        <div className="gallery-strip">
          {files.map((x, n) => (
            <button key={`${x.root}:${x.path}`} type="button" className={n === i ? "on" : ""} onClick={() => setAt(n)} aria-label={pieceTitle(x)} title={pieceTitle(x)} aria-current={n === i || undefined}>
              <img src={url(x)} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
