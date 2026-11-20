/**
 * The pure parts of Code's VS Code (VsCodeView.tsx): sizes and words for the download, which of the views fills Code, and how an
 * ask made inside VS Code (⌘L) or a file named in the chat becomes what the other side wants. No React and no styles, so the
 * tests (test/vscode-page.test.ts) can read it alone.
 */

/** What the runner says about VS Code (src/runner/vscode.ts, vscode.status). */
export interface VsStatus {
  supported: boolean;
  platform: string;
  version: string;
  downloadBytes: number | null;
  installed: { version: string; dir: string; bytes: number; /** Shipped inside Friday's app: nothing to download, nothing to remove. */ bundled?: boolean } | null;
  /** About what the unpacked build takes (the download is a third of it). */
  unpackedBytes?: number;
  /** What the person's own extensions, settings and caches take; counted when status is asked {sizes:true}. */
  dataBytes?: number | null;
  installing: { received: number; total: number; stage: "download" | "verify" | "unpack" } | null;
  error: string | null;
  running: { url: string; root: string; ready?: boolean } | null;
}

export type Editor = "vscode" | "friday";

/** The stored choice as an editor: VS Code unless Friday's own was picked. */
export const editorOf = (saved: string | null | undefined): Editor => (saved === "friday" ? "friday" : "vscode");

/** A size in the units a person reads: 214 MB, 1.2 GB. Megabytes are 1000 × 1000 here, as the download's own size is quoted. */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1000) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) (v /= 1000), i++;
  // Three figures at most: 12.3 MB, 214 MB.
  const text = v >= 100 || i === 0 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, "");
  return `${text} ${units[i]}`;
}

/** The word for a stage of the install, as the progress line says it. */
export const stageWord = (stage: "download" | "verify" | "unpack"): string => (stage === "download" ? "Downloading" : stage === "verify" ? "Checking" : "Unpacking");

/** How far along the install is: a fraction (null while the size isn't known, or when a stage has no count) and the line saying so. */
export function progressOf(p: NonNullable<VsStatus["installing"]>): { fraction: number | null; line: string } {
  const word = stageWord(p.stage);
  if (p.stage === "verify") return { fraction: null, line: `${word}… step 2 of 3` };
  if (p.stage === "unpack") return { fraction: null, line: `${word}… step 3 of 3, about a minute` };
  if (!p.total || p.total <= 0) return { fraction: null, line: p.received > 0 ? `${word} · ${formatBytes(p.received)}` : `${word}…` };
  const fraction = Math.min(1, Math.max(0, p.received / p.total));
  return { fraction, line: `${word} · ${formatBytes(p.received)} of ${formatBytes(p.total)}` };
}

export type CodeView = "loading" | "friday" | "install" | "vscode";

/**
 * Which view fills Code. Friday's editor when it is the choice, or where VS Code can't run (said in `note`); while the first look
 * at the runner is out, a loading state rather than a flash of the wrong view.
 */
export function chooseView(a: { editor: Editor; status: VsStatus | null; failed?: boolean }): { view: CodeView; note: string } {
  if (a.editor === "friday") return { view: "friday", note: "" };
  if (!a.status) return a.failed ? { view: "friday", note: "Friday couldn't reach this computer's runner. Restart Friday and open Code again." } : { view: "loading", note: "" };
  if (!a.status.supported) return { view: "friday", note: `Friday IDE has no build for this computer (${a.status.platform || "unknown"}).` };
  return { view: a.status.installed ? "vscode" : "install", note: "" };
}

const slashes = (p: string) => p.replace(/\\/g, "/");
const isAbs = (p: string) => /^([a-zA-Z]:)?\//.test(slashes(p)) || p.startsWith("\\\\");
const isWin = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");

/** A file named in the chat (relative to the folder, or absolute) as this computer's own absolute path, for vscode.open. */
export function absoluteIn(root: string, path: string): string {
  if (isAbs(path)) return path;
  const base = root.replace(/[\\/]+$/, "");
  const rel = path.replace(/^\.\//, "").replace(/^[\\/]+/, "");
  return isWin(root) ? `${base}\\${rel.replace(/\//g, "\\")}` : `${base}/${rel}`;
}

/** A path as relative to the folder when it lies inside it, else as it came. */
export function relativeIn(root: string, path: string): string {
  if (!isAbs(path)) return path.replace(/^\.\//, "");
  const a = slashes(path);
  const r = slashes(root).replace(/\/+$/, "");
  const same = isWin(root) ? a.toLowerCase().startsWith(`${r.toLowerCase()}/`) : a.startsWith(`${r}/`);
  return same ? a.slice(r.length + 1) : a;
}

/** A failed command's folder as relative to the open one ("" when it is that folder, "" too when it is outside it: only a relative folder is said). */
export function cwdIn(root: string, cwd: string): string {
  const a = slashes(cwd).replace(/\/+$/, "");
  const r = slashes(root).replace(/\/+$/, "");
  if (isWin(root) ? a.toLowerCase() === r.toLowerCase() : a === r) return "";
  const rel = relativeIn(root, cwd);
  return isAbs(rel) ? "" : rel.replace(/\\/g, "/");
}

/** What VS Code's /api/vscode/asks says: the latest ask newer than the one asked after, and the number to ask after next. */
export interface VsAsk {
  path: string;
  from: number;
  to: number;
  text: string;
  root?: string;
  /** When the server got it (ms): an ask held for long is stale, not wanted. */
  at?: number;
  /** A problem to fix or explain (the extension's "Fix with Friday", a failed command), with what it said and where. */
  kind?: "fix" | "explain" | "test" | "refactor" | "edit" | "debug" | "bisect" | "cover" | "restructure" | "restack" | "todo" | "question" | "ci";
  problem?: string;
  source?: string;
  /** The folder a failed command ran in (absolute, as the IDE has it). */
  cwd?: string;
  line?: number;
  /** A stop in the debugger (kind "debug"): why it stopped, the stack and the variables of the frame, or reproduce for the person's own words. */
  reason?: string;
  reproduce?: boolean;
  stack?: { name: string; path: string; line: number }[];
  vars?: { name: string; value: string; type?: string; scope?: string }[];
  /** An action above a function (Explain, Test, Fix, Refactor): the function's name and kind, its code is `text`. */
  symbol?: string;
  symbolKind?: string;
  /** ⌘K: what to change in these lines, in the person's words; "Ask the codebase": the question. */
  instruction?: string;
}

/** An ask older than this when the page sees it is let go (the window was hidden or asleep). */
export const ASK_FRESH_MS = 60_000;

/** The ask as the agent panel takes it (a path relative to the folder, lines from 1 and in order), or null when it has nothing to ask about. */
export function askFromVscode(root: string, a: VsAsk | null | undefined, nonce: number) {
  if (!a || (!a.path && !a.problem && !(a.kind === "debug" && a.stack?.length) && a.kind !== "bisect" && a.kind !== "question")) return null;
  // Another window's ask (one server keeps the latest of all) is not ours; an old one is not wanted.
  if (a.root && !sameRoot(a.root, root)) return null;
  if (a.at && nonce - a.at > ASK_FRESH_MS) return null;
  const from = Math.max(1, Math.floor(Number(a.from) || 1));
  const to = Math.max(from, Math.floor(Number(a.to) || from));
  return {
    path: a.path ? relativeIn(root, a.path) : "",
    from,
    to,
    text: String(a.text ?? ""),
    nonce,
    ...(a.kind ? { kind: a.kind, problem: String(a.problem ?? ""), source: String(a.source ?? ""), ...(a.cwd ? { cwd: cwdIn(root, a.cwd) } : {}), ...(a.line ? { line: a.line } : {}), ...(a.symbol ? { symbol: String(a.symbol), symbolKind: String(a.symbolKind ?? "") } : {}), ...(a.instruction ? { instruction: String(a.instruction) } : {}), ...(a.kind === "debug" ? { reason: String(a.reason ?? ""), ...(a.reproduce ? { reproduce: true } : {}), stack: Array.isArray(a.stack) ? a.stack : [], vars: Array.isArray(a.vars) ? a.vars : [] } : {}) } : {}),
  };
}

/** How long the page waits between looks at the runner: quickly while an install runs, else the 30 s heartbeat that keeps VS Code running. */
export const statusEvery = (s: VsStatus | null, notReadyFor = 0): number => (s?.installing ? 800 : s?.running && s.running.ready === false && notReadyFor < 20_000 ? 500 : 30_000);

/** Whether two folders are the same one: slashes either way, no trailing one, case ignored on Windows paths. */
export function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => {
    const t = slashes(p).replace(/\/+$/, "");
    return isWin(p) ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

/** A failure text as a plain sentence for the person: the browser's own wording for a dropped connection is not one. */
export function plainTrouble(text: string): string {
  if (/failed to fetch|networkerror|load failed|couldn't reach friday/i.test(text)) return "Friday couldn't reach this computer's runner. Check that Friday is still running, then try again.";
  return text || "Something went wrong.";
}

/** The chat column's width kept between runs, held to what fits. */
/**
 * The agent column's width: as narrow as 240px and as wide as the window allows while VS Code keeps 360px, the way VS Code's own
 * side panels are dragged (Arun, 2026-11-19: "make sure the chat panel can be dragged to the size as the native VScode panels").
 */
export const CHAT_MIN = 240;
export const chatMax = (): number => Math.max(CHAT_MIN, (typeof window === "undefined" ? 1440 : window.innerWidth) - 360);
export const clampChat = (w: number, min = CHAT_MIN, max = chatMax()): number => (Number.isFinite(w) ? Math.min(max, Math.max(min, Math.round(w))) : 380);
