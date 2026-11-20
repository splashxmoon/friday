import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api.js";
import { LazyAnswer } from "../lazy-answer.js";
import { FileIcon } from "../fileIcons.js";
import { Icon } from "../icons.js";
import type { Identity } from "../storage.js";
import type { CodeQuestion } from "../../ask-code.js";
import { ENGINE_NAMES, type EngineTool } from "../../types.js";
import { sameFolder } from "./code-chats.js";
import { getMode } from "./mode.js";
import { relativeIn } from "./vscode-util.js";
import "./ask-code.css";

/**
 * "Ask the codebase" in Code's column (Arun, 2026-11-19, wave 2: "a question about how the code works, answered with the exact
 * lines, from inside the IDE"). The IDE's ⌘⌥A box posts the question; Friday answers it through Deep Dive (src/ask-code.ts); the
 * answer opens as a tab of its own, "Ask: <question>", beside the chats, with every line it cites as a chip that opens the file at
 * those lines in the IDE. A tab is a read, not a chat: nothing here can change the code.
 *
 * Per window (sessionStorage): the answers are a convenience, and a Deep Dive keeps the ones it answered itself.
 */
export interface AskTab {
  /** This window's name for the tab. */
  id: string;
  folder: string;
  question: string;
  about?: { path: string; from: number; to: number };
  status: "asking" | "done" | "failed";
  answer: string;
  cites: { file: string; start: number; end: number }[];
  error?: string;
  /** The server's name for the question: what a reload follows to find the answer it was still writing. */
  qid?: string;
  source: "dive" | "tool";
  from?: string;
  tool?: EngineTool;
  at: number;
}

const KEY = "friday.code.asks";
const MAX_TABS = 8;
const listeners = new Set<() => void>();
const load = (): AskTab[] => {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    // One still being answered when the page went away is followed again (resumeAsks) if the server had taken it; one it never took is lost.
    return Array.isArray(v) ? v.filter((t) => t && typeof t.id === "string" && typeof t.folder === "string").map((t: AskTab) => (t.status === "asking" && !t.qid ? { ...t, status: "failed" as const, error: "Friday was reloaded before it answered. Ask again." } : t)) : [];
  } catch {
    return [];
  }
};
let tabs: AskTab[] = load();
const change = (next: AskTab[]) => {
  tabs = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next.slice(-30)));
  } catch {
    // Kept until the window closes.
  }
  listeners.forEach((l) => l());
};
const patch = (id: string, p: Partial<AskTab>) => change(tabs.map((t) => (t.id === id ? { ...t, ...p } : t)));
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** The question's tab, as a name for it in a tab strip: "Ask: how does login work?" */
export const askTitle = (q: string): string => `Ask: ${q}`;

const memo = new Map<string, { from: AskTab[]; list: AskTab[] }>();
const EMPTY: AskTab[] = [];
/** The folder's Ask tabs, oldest first; the same list between changes. */
export function useAskTabs(folder: string): AskTab[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!folder) return EMPTY;
      const hit = memo.get(folder);
      if (hit && hit.from === tabs) return hit.list;
      const list = tabs.filter((t) => sameFolder(t.folder, folder));
      const out = list.length ? list : EMPTY;
      memo.set(folder, { from: tabs, list: out });
      return out;
    },
    () => EMPTY,
  );
}

export const closeAsk = (id: string): void => change(tabs.filter((t) => t.id !== id));

/** What the IDE sent: the question (as `instruction`), and the selected lines when there were some. */
export interface QuestionAsk {
  instruction?: string;
  path: string;
  from: number;
  to: number;
  text: string;
}

const POLL_MS = 1000;
/**
 * A question is given as long as the server gives its tool (10 minutes a try, a second try on the tool's own model, and a second
 * tool after that) before the tab says it never came back.
 */
const GIVE_UP_MS = 30 * 60_000;
/** A few polls may fail (a network blip, the server restarting) before the tab does. */
const POLL_FAILS = 5;
const following = new Set<string>();

/** Follows the server's question until it has an answer, and puts the answer on the tab. */
async function follow(identity: Identity, id: string, qid: string, since: number): Promise<void> {
  if (following.has(id)) return;
  following.add(id);
  try {
    let fails = 0;
    for (;;) {
      await new Promise((res) => setTimeout(res, POLL_MS));
      if (!tabs.some((t) => t.id === id)) return; // closed meanwhile
      try {
        const q = (await api<{ question: CodeQuestion }>(identity, `/api/vscode/question?id=${encodeURIComponent(qid)}`)).question;
        fails = 0;
        if (q.status !== "asking") {
          return patch(id, { status: q.status, answer: q.answer, cites: q.cites, source: q.source, ...(q.from ? { from: q.from } : {}), ...(q.tool ? { tool: q.tool } : {}), ...(q.error ? { error: q.error } : {}), at: Date.now() });
        }
      } catch (e) {
        const m = (e as Error).message || "";
        // Gone from the server (it was restarted): nothing more is coming. Anything else may pass.
        if (/gone/i.test(m)) return patch(id, { status: "failed", error: "Friday was restarted before it answered. Ask again." });
        if (++fails >= POLL_FAILS) return patch(id, { status: "failed", error: m || "Friday couldn't answer that." });
      }
      if (Date.now() - since > GIVE_UP_MS) return patch(id, { status: "failed", error: "It took too long. Try a narrower question." });
    }
  } finally {
    following.delete(id);
  }
}

/** Picks the questions still being answered back up after a reload. */
export function resumeAsks(identity: Identity | null): void {
  if (!identity) return;
  for (const t of tabs) if (t.status === "asking" && t.qid) void follow(identity, t.id, t.qid, t.at);
}

/** Starts the question: its tab is there at once, asking, and fills in when Friday has the answer. Returns the tab's id. `tool` is the one the column is using. */
export function startAsk(identity: Identity | null, folder: string, a: QuestionAsk, tool?: string, id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`): string | null {
  const question = (a.instruction ?? "").trim();
  if (!identity || !folder || !question) return null;
  const rel = a.path ? relativeIn(folder, a.path) : "";
  const about = rel && a.text ? { path: rel, from: a.from, to: a.to } : undefined;
  const mine = tabs.filter((t) => sameFolder(t.folder, folder));
  // Past the limit the oldest answered tab goes; one still being answered stays.
  const drop = mine.length >= MAX_TABS ? mine.find((t) => t.status !== "asking") : undefined;
  const at = Date.now();
  change([...tabs.filter((t) => t !== drop), { id, folder, question, ...(about ? { about } : {}), status: "asking", answer: "", cites: [], source: "tool", at }]);
  void (async () => {
    try {
      const r = await api<{ question: CodeQuestion }>(identity, "/api/vscode/question", { method: "POST", body: JSON.stringify({ folder, question, ...(tool ? { tool } : {}), ...(about ? { path: rel, from: a.from, to: a.to, text: a.text } : {}) }) });
      patch(id, { qid: r.question.id });
      await follow(identity, id, r.question.id, at);
    } catch (e) {
      patch(id, { status: "failed", error: (e as Error).message || "Friday couldn't answer that." });
    }
  })();
  return id;
}

/** The Ask tab's place in the column's tab strip (AgentPanel). */
export function AskTabs({ tabs: list, on, onPick, onClose }: { tabs: AskTab[]; on: string | null; onPick: (id: string) => void; onClose: (id: string) => void }) {
  return (
    <>
      {list.map((t) => (
        <div key={t.id} role="tab" aria-selected={t.id === on} tabIndex={t.id === on ? 0 : -1} className={`ia-tab ia-tab-ask${t.id === on ? " on" : ""}`} title={askTitle(t.question)} aria-label={askTitle(t.question)} onClick={() => onPick(t.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(t.id))} onAuxClick={(e) => e.button === 1 && onClose(t.id)}>
          <span className="ia-tab-mark" aria-hidden="true">{t.status === "asking" ? <span className="aq-spin" /> : <Icon name="search" size={13} />}</span>
          {/* The search mark says it is a question; "Ask: " is in the tooltip and the name read aloud, not taking the tab. */}
          <span className="ia-tab-name">{t.question}</span>
          <button type="button" className="ia-tab-x" aria-label={`Close “${askTitle(t.question)}”`} title="Close" onClick={(e) => (e.stopPropagation(), onClose(t.id))}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
    </>
  );
}

const linesOf = (a: { from: number; to: number }) => (a.from === a.to ? `${a.from}` : `${a.from}-${a.to}`);

/** What the column shows under an Ask tab: the question, the answer, and the lines it cites. */
export function AskPanel({ tab, root, identity, onOpenFile }: { tab: AskTab; root: string; identity: Identity | null; onOpenFile: (path: string, line?: number, end?: number) => void }) {
  const open = useRef(onOpenFile);
  open.current = onOpenFile;
  // A citation in the answer's own words is a chip too (AnswerParts FileChip, which says the page should open it): taken here, in the
  // IDE, but only when it was pressed inside this answer (the click is marked on the way down), never another place's.
  const body = useRef<HTMLDivElement>(null);
  const pressed = useRef(false);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ path?: string; line?: number; outside?: boolean }>).detail;
      if (!pressed.current || !d?.path || d.outside || getMode() !== "code") return;
      const rel = relativeIn(root, d.path);
      // Still a full path: outside this folder, so not the IDE's to open.
      if (/^([a-z]:)?[\\/]/i.test(rel)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      open.current(rel, d.line);
    };
    window.addEventListener("friday:open-file", on, true);
    return () => window.removeEventListener("friday:open-file", on, true);
  }, [root, tab.id]);
  const mark = () => {
    pressed.current = true;
    setTimeout(() => (pressed.current = false), 0);
  };

  // Whether the repo has a Deep Dive by now: asked of the server, not guessed from when the answer came, so a build that has finished
  // since, or a Deep Dive this folder shares with its repo (a worktree), is never offered to be built over.
  const [dive, setDive] = useState<"" | "ready" | "building" | "none">("");
  useEffect(() => {
    if (!identity || tab.status !== "done" || tab.source !== "tool") return;
    let live = true;
    api<{ dive: "ready" | "building" | "none" }>(identity, `/api/vscode/question?folder=${encodeURIComponent(tab.folder)}`).then((r) => live && setDive(r.dive), () => {});
    return () => void (live = false);
  }, [identity, tab.id, tab.status, tab.source, tab.folder]);
  const [building, setBuilding] = useState<"" | "starting" | "started" | string>("");
  const build = async () => {
    if (!identity || !tab.tool) return;
    setBuilding("starting");
    try {
      // Asked again just before: a Deep Dive that is there is never built over from here.
      const now = (await api<{ dive: "ready" | "building" | "none" }>(identity, `/api/vscode/question?folder=${encodeURIComponent(tab.folder)}`)).dive;
      setDive(now);
      if (now !== "none") return void setBuilding("");
      await api(identity, "/api/deepdive/build", { method: "POST", body: JSON.stringify({ folder: tab.folder, tool: tab.tool }) });
      setBuilding("started");
    } catch (e) {
      setBuilding((e as Error).message || "It couldn't start.");
    }
  };
  const failed = tab.status === "failed";
  return (
    <div className="aq" data-testid="ask-panel">
      <div className="aq-scroll">
        <h2 className="aq-q">{tab.question}</h2>
        {tab.about && (
          <button type="button" className="aq-about" title="Open the lines the question was about" onClick={() => open.current(tab.about!.path, tab.about!.from)}>
            <FileIcon path={tab.about.path} size={13} />
            <span>About {tab.about.path.split("/").pop()}:{linesOf(tab.about)}</span>
          </button>
        )}
        {tab.status === "asking" ? (
          <p className="aq-wait" role="status"><span className="aq-spin" aria-hidden="true" /> Reading the code…</p>
        ) : failed ? (
          <p className="aq-fail" role="alert">It couldn’t answer: {tab.error || "no reason given"}.</p>
        ) : (
          <>
            <div className="aq-body" ref={body} onClickCapture={mark}>
              <LazyAnswer text={tab.answer} />
            </div>
            {tab.cites.length > 0 && (
              <div className="aq-sources" role="group" aria-label="Lines it cites">
                <span className="aq-label">Cited</span>
                {tab.cites.map((c) => (
                  <button key={`${c.file}:${c.start}-${c.end}`} type="button" className="aq-chip" title={`Open ${c.file} at ${c.start === c.end ? `line ${c.start}` : `lines ${c.start}-${c.end}`}`} onClick={() => open.current(relativeIn(root, c.file), c.start, c.end)}>
                    <FileIcon path={c.file} size={13} />
                    <span className="aq-chip-name">
                      <span className="aq-chip-file">{c.file.split("/").pop()}</span>
                      <span className="aq-chip-range">:{c.start === c.end ? c.start : `${c.start}-${c.end}`}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p className="aq-foot">
              {tab.source === "dive" ? `Answered from the Deep Dive of ${tab.from || "this repo"}.` : `Answered by ${tab.tool ? ENGINE_NAMES[tab.tool] : tab.from || "your coding tool"} reading the code, read-only.`}
              {tab.source === "tool" && tab.tool && identity && (building === "started" || dive === "building" ? (
                <span> A Deep Dive is being written: it’s under Deep Dive in Friday.</span>
              ) : dive === "ready" ? (
                <span> This repo has a Deep Dive: ask again to answer from it.</span>
              ) : dive === "none" ? (
                <>
                  {" "}
                  <button type="button" className="aq-link" disabled={building === "starting"} onClick={build}>
                    {building === "starting" ? "Starting…" : "Build a Deep Dive for this repo"}
                  </button>
                  {building && building !== "starting" && <span className="aq-err"> {building}</span>}
                </>
              ) : null)}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
