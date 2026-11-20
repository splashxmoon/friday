import { lazy, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api.js";
import { hostApi } from "../local.js";
import type { Identity } from "../storage.js";
import type { GithubIssues, InboxIssue } from "../../issues.js";
import { EngineMark } from "../BrandMarks.js";
import { Icon } from "../icons.js";
import { MenuButton } from "../ui.js";
import { ENGINE_NAMES, MAIN_LANE, type EngineTool } from "../../types.js";
import type { AskLane } from "../Activity.js";
import { getMode, IdeChatContext, setIdeRoot, swapMode, type QuietStart } from "./mode.js";
import { dismissMoved, MovedPanel, openInAgents, sendToAgents, useMovedChats } from "./send-to-agents.js";
import { Face } from "../Teammates.js";
import { HandMenu, handToMate, openMateThread, WithMatePanel, type Mate } from "./hand-to-mate.js";
import { closeCodeTab, handBack, isCodeChat, loadCodeChats, moveToCode, removeCodeChat, sameFolder, showCodeChat, useCodeChatFor, useCodeChats, useCodeTabs, type CodeChat } from "./code-chats.js";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The box's hint in Code: one short line (the session's own is two in a column this narrow). */
const ASK_PLACEHOLDER = `Ask about this file, or ${MAC ? "⌘L" : "Ctrl+L"} with code selected`;
/** Beside VS Code the panel does not know which file is open: it says what ⌘L does instead. */
const VSCODE_PLACEHOLDER = `Ask, or ${MAC ? "⌘L" : "Ctrl+L"} in the IDE`;
import { actionText } from "./action-text.js";
import { debugText } from "./debug-text.js";
import { bisectText } from "../bisect.js";
import { coverText } from "./cover-text.js";
import { todoText } from "./todo-text.js";
import { refactorAsk, REFACTOR_STARTER } from "../refactor-plan.js";
import "./agent-panel.css";
import { checkpointItems, RewoundBar, useRewindFor } from "./rewind-column.js";
import { RestoreBar } from "./RestoreBar.js";
// Usage-aware routing's bar (Arun, 2026-11-20, wave 5): only shows when a tool is heading for its limit, so it loads when asked for.
const LimitBar = lazy(() => import("./limit-bar.js"));
import "./restore.css";
import { dismissMissedFolder, useChatScroll, useMissedFolder } from "./restore.js";
import { SELF_REVIEW_ASK, TICKET_REVIEW_STEP } from "../self-review.js";
import { useNeedMarks } from "../Attention.js";
import { agentsWaiting, openAgentsNeeds } from "./waiting.js";
import { AskPanel, AskTabs, closeAsk, resumeAsks, startAsk, useAskTabs } from "./ask-code.js";

/**
 * "Take a ticket": the GitHub issues assigned to you (this computer's own GitHub sign-in, /api/runner/issues), this folder's repo
 * first. Read once when the menu opens.
 */
function TicketPick({ identity, folder, onPick }: { identity: Identity | null; folder: string; onPick: (url: string) => void }) {
  const [list, setList] = useState<InboxIssue[] | null>(null);
  const [why, setWhy] = useState("");
  const load = () => {
    if (!identity || list) return;
    void hostApi<GithubIssues>(identity, "/api/runner/issues").then(
      (r) => {
        if (!r.available) setWhy(r.reason || "GitHub isn't signed in on this computer.");
        const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
        const all = [...r.assigned, ...r.authored.filter((x) => !r.assigned.some((a) => a.key === x.key))];
        all.sort((a, b) => Number((b.repo ?? "").toLowerCase().endsWith(`/${name}`)) - Number((a.repo ?? "").toLowerCase().endsWith(`/${name}`)));
        setList(all.slice(0, 25));
      },
      (e: Error) => (setWhy(e.message), setList([])),
    );
  };
  return (
    <MenuButton
      className="ia-suggest-row ia-ticket"
      label="Take a ticket"
      width={340}
      maxHeight={380}
      items={() => {
        load();
        if (!list) return [{ heading: "Loading your issues…" }];
        if (!list.length) return [{ heading: why || "No open issues assigned to you" }];
        return [{ heading: "Assigned to you" }, ...list.map((x) => ({ label: x.title, sub: x.ref, title: x.url, onSelect: () => onPick(x.url) }))];
      }}
    >
      <Icon name="flag" size={14} />
      <span>Take a ticket</span>
      <Icon name="chevronDown" size={12} className="ia-ticket-caret" />
    </MenuButton>
  );
}

/**
 * Friday's tasks in a line on the footer's right (Arun, 2026-11-19: "make sure this button footer thing is using the space on the
 * right as well"): waiting on you, running, PRs ready, as the IDE's task board has them (/api/vscode/tasks). A press opens the
 * board. Nothing when there is nothing to say.
 */
function TaskLine({ identity }: { identity: Identity | null }) {
  const [n, setN] = useState<{ waiting: number; running: number; pr: number }>({ waiting: 0, running: 0, pr: 0 });
  useEffect(() => {
    if (!identity) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      if (document.hidden || getMode() !== "code") return void (t = setTimeout(look, 8000));
      try {
        const r = await api<{ tasks: { status: string; where?: string; linked?: boolean }[] }>(identity, "/api/vscode/tasks");
        if (stop) return;
        // Code's own line: an Agents session listed on the Tasks view is counted in Agents, not here.
        const c = (s: string) => r.tasks.filter((x) => x.status === s && (x.where !== "agents" || x.linked)).length;
        setN((p) => {
          const next = { waiting: c("waiting"), running: c("running"), pr: c("pr") };
          return p.waiting === next.waiting && p.running === next.running && p.pr === next.pr ? p : next;
        });
      } catch {
        // A moment away: the last line stands.
      }
      if (!stop) t = setTimeout(look, 4000);
    };
    void look();
    return () => ((stop = true), clearTimeout(t));
  }, [identity]);
  // What waits on you in Agents (its Needs you), said here too (Arun, 2026-11-19: "one Waiting on you"); Code's own chats are counted above.
  const marks = useNeedMarks();
  // A linked tab (an Agents session open here) is in the task line above already: counted once, there.
  const inAgents = agentsWaiting(marks.needs, (sid) => isCodeChat(sid) || loadCodeChats().some((c) => c.sid === sid));
  if (!n.waiting && !n.running && !n.pr && !inAgents) return null;
  return (
    <>
      {(n.waiting > 0 || n.running > 0 || n.pr > 0) && (
        <button type="button" className="ia-foot-line" title="Friday's tasks" onClick={() => window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "showTasks" }))}>
          {n.waiting > 0 && <span><i className="w" />{n.waiting} waiting on you</span>}
          {n.running > 0 && <span><i className="r" />{n.running} running</span>}
          {n.pr > 0 && <span><i className="p" />{n.pr} PR{n.pr === 1 ? "" : "s"} ready</span>}
        </button>
      )}
      {inAgents > 0 && (
        <button type="button" className="ia-foot-line ia-foot-agents" title="Open Needs you in Agents (PR reviews are counted there, not here)" onClick={openAgentsNeeds}>
          <span><i className="w" />{inAgents} waiting in Agents</span>
        </button>
      )}
    </>
  );
}

/** A chat's name made short for a tab or a row: its first line, cut at a word, "…" when cut. The whole is in the tooltip. */
export function shortTitle(title: string, max = 26): string {
  const t = (title || "Untitled").split(/\n|(?<=[.?!])\s/)[0]!.trim() || "Untitled";
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : t.slice(0, max)).replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/**
 * A ticket handed to the agent (Arun, 2026-11-19, the engineer loop: "hand off a ticket, get back a reviewable PR"): the issue's
 * link first (the box reads it, names the chat after it and gives the agent its text), then the loop, plan first and a pull request
 * at the end.
 */
export function ticketText(url: string): string {
  return `${url}

Take this ticket.
1. Read the code it touches and write a short plan: the files you'll change, the approach, and any risk. Then stop and wait for my OK.
2. When I say go, do it on a new branch.
3. Prove it: run the tests, the linter and the type check, and fix what fails.
4. ${TICKET_REVIEW_STEP}
5. Commit, push and open a pull request that says what changed and why, and give me its link.
`;
}

/** The empty state's starting points: each fills the box (never sends), to be sent as is or finished first. */
const STARTERS: { label: string; text: string; icon: "book" | "wrench" | "check" | "gitBranch" | "list" }[] = [
  { label: "Explain this codebase", text: "Explain how this codebase is laid out: the main parts, how they fit together, and where to start reading.", icon: "book" },
  { label: "Find and fix a bug", text: "Find a bug in this code and fix it. Tell me what it was and how you checked the fix.", icon: "wrench" },
  { label: "Add tests", text: "Add tests for the parts of this code that have none, and run them.", icon: "check" },
  // (Arun, 2026-11-19, wave 2: "tell Friday what broke; an agent runs git bisect") The box is filled, and ends on a "What broke:" line with the
  // caret after it: one phrase and Enter.
  { label: "Find what broke", text: `${bisectText()}\nWhat broke: `, icon: "gitBranch" },
  // Plans every file first and waits for a go-ahead (refactor-plan.ts; Arun, 2026-11-19: "the agent plans every file first, you approve").
  { label: "Refactor across the codebase", text: REFACTOR_STARTER, icon: "list" },
];

/** Code that was selected in the editor and sent to the chat (⌘L): the file, its lines, and the text. */
export interface AskedAbout {
  path: string;
  from: number;
  to: number;
  text: string;
  /** Changes with every ask, so asking about the same lines twice fills the box twice. */
  nonce: number;
  /** A problem from the IDE ("Fix with Friday", a failed command): a new chat is started for it, not the box filled. */
  kind?: "fix" | "explain" | "test" | "refactor" | "edit" | "debug" | "bisect" | "cover" | "restructure" | "restack" | "todo" | "question" | "ci";
  problem?: string;
  source?: string;
  /** Where a failed command ran, relative to the folder ("" when at its top). */
  cwd?: string;
  line?: number;
  /** A stop in the debugger (kind "debug"): see debug-text.ts. */
  reason?: string;
  reproduce?: boolean;
  stack?: { name: string; path: string; line: number }[];
  vars?: { name: string; value: string; type?: string; scope?: string }[];
  /** From an action above a function: its name and kind (actionText writes the instruction). */
  symbol?: string;
  symbolKind?: string;
  /** ⌘K: what to change in these lines (kind "edit"); "Ask the codebase": the question (kind "question"). */
  instruction?: string;
}

/** What a fix or an explain asks of the agent: the problem as the IDE said it, where, and the code around it. */
export function fixText(a: AskedAbout): string {
  // ⌘K (Arun, 2026-11-19: "Select code, say 'make this async'... No chat needed for small edits"): a small change in place. The
  // IDE shows it as a diff with Keep / Undo, so the agent is held to those lines, and to the file, and told to leave the commit.
  // Worded so smartReach reads it as a change, not as "no changes" or a run: "do not commit" read as hands-off and put the chat in
  // Plan (it could not edit), and "run the tests" as Auto from the start.
  if (a.kind === "edit") {
    const name = `${a.path.split(/[\\/]/).pop()}:${a.from}`;
    const where = a.from === a.to ? `line ${a.from}` : `lines ${a.from}–${a.to}`;
    return `Edit ${name}

Change ONLY ${where} of \`${a.path}\`, as asked below, and leave everything else as it is: the other lines, the other files, anything around it. Leave the commit to me, and leave the tests and the build alone. When done, say what you changed in one line.

What to change: ${(a.instruction || "").trim()}

\`${a.path}:${a.from}–${a.to}\` as it is now:
\`\`\`
${a.text.replace(/\n$/, "")}
\`\`\`
`;
  }
  if (a.kind === "debug") return debugText(a);
  const at = a.path ? `${a.path}:${a.line ?? a.from}` : "";
  const cmd = /^the terminal · (.+)$/.exec(a.source ?? "")?.[1];
  // The first line is the chat's name in its tab: "Fix refunds.ts:24", "Explain `pnpm test`".
  const name = at ? `${at.split("/").pop()}` : cmd ? `\`${cmd.length > 40 ? `${cmd.slice(0, 39)}…` : cmd}\`` : "the failure";
  const title = `${a.kind === "explain" ? "Explain" : "Fix"} ${name}`;
  const ask =
    a.kind === "explain"
      ? "What causes this here, and how should it be fixed? Don't change anything yet."
      : "Reproduce it first, find the cause and fix that, add a test that would have caught it, and run the tests. Say the cause in a line or two.";
  const said = a.problem ? `\n\nWhat ${a.source || "the editor"} said:\n\`\`\`\n${a.problem.replace(/\n+$/, "")}\n\`\`\`` : "";
  const code = a.path && a.text ? `\n\n\`${a.path}:${a.from}–${a.to}\`\n\`\`\`\n${a.text.replace(/\n$/, "")}\n\`\`\`` : "";
  return `${title}\n\n${ask}${said}${code}\n`;
}

/**
 * "Fix with Friday" on the status bar's checks (Arun, 2026-11-19, wave 3: "a failure opens at the failing line with the log, and Fix with
 * Friday"): the failed checks as the server worded them for the agent (pr-checks.ts checksText), under a first line that names the chat's tab.
 */
export function ciFromAsk(a: AskedAbout): string {
  const p = (a.problem ?? "").trim();
  const n = Number(/^\[ci\] (\d+) check/.exec(p)?.[1]) || 0;
  const pr = /\/pull\/(\d+)/.exec(p)?.[1];
  // The first line is what the tab and the bubble say: what failed and where, in a few words ("Fix CI: unit failed on #7").
  const first = /^### (.+?)(?: \(.*\))?(?: — .*)?$/m.exec(p)?.[1];
  const what = first ? `${first}${n > 1 ? ` and ${n - 1} more` : ""} failed` : n ? `${n} failing` : "";
  return `Fix CI${what ? `: ${what}` : ""}${pr ? ` on #${pr}` : ""}\n\n${p}\n`;
}

/** A "Find what broke" ask from the IDE: a failed command is the check (with its output), else the person's own words. */
export function bisectFromAsk(a: AskedAbout): string {
  // [\s\S]: a command can run over several lines.
  const cmd = /^the terminal · ([\s\S]+)$/.exec(a.source ?? "")?.[1];
  return cmd ? bisectText({ command: cmd, output: a.problem, folder: a.cwd }) : bisectText({ what: a.problem });
}

/** Where a path the chat names sits in the open folder, or null when it is outside it. */
export function relativeTo(root: string, path: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const p = path.replace(/\\/g, "/");
  // Windows drive letters and Mac paths differ in case only by volume, so the drive is compared without it.
  const same = (a: string, b: string) => (/^[a-z]:\//i.test(a) ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b));
  if (!/^([a-z]:)?\//i.test(p)) return p.replace(/^\.\//, "");
  return r && same(p, `${r}/`) ? p.slice(r.length + 1) : null;
}

/** The message box's words for an ask: a reference to the lines, then the code in a fence. */
export function askText(a: AskedAbout): string {
  const ref = a.from === a.to ? `${a.path}:${a.from}` : `${a.path}:${a.from}–${a.to}`;
  return `\`${ref}\`\n\n\`\`\`\n${a.text.replace(/\n$/, "")}\n\`\`\`\n`;
}

/**
 * Code's agent column: its own chats, apart from Agents (Arun, 2026-11-19: "the agent chat thing, we will keep all of the session
 * stuff and agents from the agent platform seperate, and we need to make this work and design it nicely as well").
 *
 * The folder Code has open shows its chat: the one picked from the history, else its newest, else the box to start one. A chat is
 * a session underneath, drawn by the same session screen as Agents (App's IdeChatContext), so messages, steps, approvals and the
 * changes card behave the same; what differs is that it is listed here (code-chats.ts), and a file it names opens in VS Code.
 */
export function AgentPanel({
  root,
  asked,
  onOpenFile,
  onClose,
  editor,
}: {
  /** The folder Code has open; "" in VS Code's empty window. */
  root: string;
  asked?: AskedAbout | null;
  onOpenFile: (path: string, line?: number, end?: number) => void;
  onClose?: () => void;
  /** Beside real VS Code (VsCodeView): the box's hint says so. */
  editor?: "vscode";
}) {
  const hint = editor === "vscode" ? VSCODE_PLACEHOLDER : ASK_PLACEHOLDER;
  const app = useContext(IdeChatContext);
  const chat = useCodeChatFor(root);
  const all = useCodeChats();
  const tabs = useCodeTabs(root);
  const sid = chat?.sid ?? null;
  // The chat's checkpoints, for the history menu's top (rewind-column.tsx); the bar under the tabs reads the same.
  const rewindable = useRewindFor(sid);
  const [reviewing, setReviewing] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [moved, setMoved] = useState<string | null>(null);
  // "Moved to Agents" tabs left by Send to Agents (send-to-agents.tsx); the one open, if any, is what the column shows.
  const movedTabs = useMovedChats(root);
  const [movedOn, setMovedOn] = useState<string | null>(null);
  const movedShown = movedTabs.find((m) => m.sid === movedOn) ?? null;
  // "Ask the codebase" answers (ask-code.tsx), one tab each beside the chats; a "Moved to Agents" tab on show wins the column.
  const askTabs = useAskTabs(root);
  const [askOn, setAskOn] = useState<string | null>(null);
  const askShown = movedShown ? null : askTabs.find((t) => t.id === askOn) ?? null;
  const over = !!movedShown || !!askShown;
  // The panel is one more tab, not an overlay: whatever the person picks, asks or starts in the column takes it down.
  useEffect(() => {
    const on = (e: Event) => {
      const f = (e as CustomEvent<{ folder?: string }>).detail?.folder;
      if (!f || !root || sameFolder(f, root)) (setMovedOn(null), setAskOn(null));
    };
    window.addEventListener("friday:code-shown", on);
    return () => window.removeEventListener("friday:code-shown", on);
  }, [root]);
  useEffect(() => setMovedOn(null), [asked?.nonce, root]);
  // A question from the IDE's Ask the codebase box: its answer opens in a tab of its own, never in a chat (Arun, 2026-11-19: "a
  // question about how the code works, answered with the exact lines, from inside the IDE").
  useEffect(() => {
    // Any other ask that fills or starts a chat shows the chat, not an answer (a ⌘K edit leaves the column as it was).
    if (asked && asked.kind !== "question" && asked.kind !== "edit") setAskOn(null);
  }, [asked?.nonce]);
  useEffect(() => resumeAsks(app?.identity ?? null), [app?.identity]);
  const questioned = useRef(0);
  useEffect(() => {
    if (asked?.kind !== "question" || !root || questioned.current === asked.nonce) return;
    questioned.current = asked.nonce;
    // Asked of the tool the column is on: this chat's, else the last tab's.
    const last = chat ?? tabs[tabs.length - 1];
    const id = startAsk(app?.identity ?? null, root, asked, (last && (app?.agentOf(last.sid) || last.tool)) || undefined);
    if (id) (setMovedOn(null), setAskOn(id));
  }, [asked, root, app]);
  const nowOn = useRef({ sid, root });
  nowOn.current = { sid, root };
  const sending = useRef(new Set<string>());
  // The same in state, so the menu rows and the line "Handing to Rio…" follow it (a ref is not read again on render).
  const [away, setAway] = useState<{ sid: string; text: string } | null>(null);
  const sendAway = () => {
    if (!chat || sending.current.has(chat.sid)) return;
    const at = { sid: chat.sid, root };
    sending.current.add(at.sid);
    setAway({ sid: at.sid, text: "Sending to Agents…" });
    sendToAgents(app?.identity ?? null, chat, () => {
      // Shown only if the column is still on that chat; if they moved on meanwhile the tab waits, unopened.
      if (nowOn.current.sid === at.sid && nowOn.current.root === at.root) setMovedOn(at.sid);
    }).then(
      () => (sending.current.delete(at.sid), setAway(null)),
      (e: Error) => {
        sending.current.delete(at.sid);
        setAway(null);
        window.dispatchEvent(new CustomEvent("friday:notice", { detail: e.message || "Couldn't send it to Agents." }));
      },
    );
  };
  // Friday's palette in the IDE asks for the same thing as the menu item (palette-run.ts): this chat, through the same guard.
  const sendNow = useRef(sendAway);
  sendNow.current = sendAway;
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === nowOn.current.sid) sendNow.current();
    };
    window.addEventListener("friday:send-away", on);
    return () => window.removeEventListener("friday:send-away", on);
  }, []);
  // Hand to a teammate (hand-to-mate.tsx): the same guard and the same tab as Send to Agents, "With <name>" in place of "Moved to Agents".
  const handAway = (mate: Mate) => {
    if (!chat || !app || sending.current.has(chat.sid)) return;
    const at = { sid: chat.sid, root };
    sending.current.add(at.sid);
    setAway({ sid: at.sid, text: `Handing to ${mate.name.split(/\s+/)[0] || mate.name}…` });
    handToMate(app.identity, chat, mate, (m) => {
      if (nowOn.current.sid === at.sid && nowOn.current.root === at.root) setMovedOn(m.sid);
    }).then(
      () => (sending.current.delete(at.sid), setAway(null)),
      (e: Error) => {
        sending.current.delete(at.sid);
        setAway(null);
        window.dispatchEvent(new CustomEvent("friday:notice", { detail: e.message || `Couldn't hand it to ${mate.name}.` }));
      },
    );
  };
  const chatEl = useRef<HTMLDivElement>(null);
  // Where each chat was scrolled to is kept and put back (ide/restore.ts; Arun, 2026-11-19: "come back exactly where you were").
  useChatScroll(chatEl, askShown || movedShown || !root || !app ? undefined : sid ?? undefined);
  const missed = useMissedFolder();
  const open = useRef(onOpenFile);
  open.current = onOpenFile;

  // A file the chat names (a path, a path:line, a changed file's card) opens in the editor. Captured before the session's own
  // listener, which would open it in its side panel inside this narrow column; ⌘-click "open in your own editor" is left alone.
  useEffect(() => {
    if (!sid || !root) return;
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ path?: string; line?: number; outside?: boolean }>).detail;
      // Kept while Agents shows: a file named there is Agents' to open, not this hidden column's.
      if (!d?.path || d.outside || getMode() !== "code") return;
      const rel = relativeTo(root, d.path);
      if (rel === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      open.current(rel, d.line);
    };
    window.addEventListener("friday:open-file", on, true);
    return () => window.removeEventListener("friday:open-file", on, true);
  }, [sid, root]);

  // A problem to fix or explain, from the IDE: a new chat, in a tab of its own, started at once with the problem in it (Arun,
  // 2026-11-19, the engineer loop: "Fix with an agent, wherever it broke").
  const fixed = useRef(0);
  useEffect(() => {
    if (!asked?.kind || asked.kind === "edit" || asked.kind === "question" || !root || fixed.current === asked.nonce) return;
    fixed.current = asked.nonce;
    done.current = asked.nonce;
    showCodeChat(root, "new");
    // "restack": the Stack view stopped on a conflict and handed it over (its words are the whole ask: stack-plan.ts restackHandoff).
    const text = asked.kind === "ci" ? ciFromAsk(asked) : asked.kind === "restack" ? (asked.problem ?? "") : asked.kind === "bisect" ? bisectFromAsk(asked) : asked.kind === "cover" ? coverText(asked) : asked.kind === "todo" ? todoText(asked) : asked.kind === "restructure" ? refactorAsk(asked.problem ?? "", asked.symbol) : asked.symbol || asked.kind === "test" || asked.kind === "refactor" ? actionText(asked) : fixText(asked);
    let tries = 0;
    let filled = false;
    const tick = window.setInterval(() => {
      const box = chatEl.current?.querySelector<HTMLTextAreaElement>(".ia-new textarea");
      const send = chatEl.current?.querySelector<HTMLButtonElement>('.ia-new button[aria-label="Start the run"]');
      if (box && !filled) {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        box.value = "";
        set?.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
        filled = true;
      } else if (filled && send && !send.disabled) {
        window.clearInterval(tick);
        send.click();
      }
      if (++tries > 80) window.clearInterval(tick);
    }, 100);
    return () => window.clearInterval(tick);
  }, [asked, root]);

  // A ⌘K edit (Arun, 2026-11-19: "No chat needed for small edits"): its chat is started with no one looking: a composer mounted out
  // of sight takes the task and sends it, and the chat gets its tab without becoming the one shown, so what is on screen (a draft in
  // the new-chat box, a chat being typed in) is never touched. Each ask has its own, so two in a row both start.
  const [quiet, setQuiet] = useState<QuietStart[]>([]);
  const edited = useRef(0);
  useEffect(() => {
    if (asked?.kind !== "edit" || !root || edited.current === asked.nonce) return;
    edited.current = asked.nonce;
    const id = String(asked.nonce);
    // Taken away a moment after it has said it started (or could not), once the session it made has settled.
    const gone = () => window.setTimeout(() => setQuiet((q) => q.filter((x) => x.id !== id)), 1500);
    setQuiet((q) => [...q, { id, text: fixText(asked), done: () => void gone() }]);
  }, [asked, root]);

  // Asked about some code (⌘L): the box is filled once it has drawn, the chat's or the new one's (each is lazy, so it may take a moment).
  const done = useRef(0);
  useEffect(() => {
    if (!asked || asked.kind || !root || done.current === asked.nonce) return;
    let tries = 0;
    const text = askText(asked);
    const tick = window.setInterval(() => {
      const el = chatEl.current?.querySelector<HTMLTextAreaElement>("textarea");
      if (el) {
        window.clearInterval(tick);
        done.current = asked.nonce;
        // The ask may come from VS Code's frame, which holds the keyboard: take it back so typing carries on, and show where it landed.
        window.focus();
        el.focus();
        // Added after what is already typed, never over it, set as typing would so the box's own state follows.
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        const next = el.value.trim() ? `${el.value.replace(/\s+$/, "")}\n\n${text}` : text;
        el.value = "";
        set?.call(el, next);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.setSelectionRange(next.length, next.length);
        const box = el.parentElement;
        if (box) {
          box.classList.add("ia-landed");
          window.setTimeout(() => box.classList.remove("ia-landed"), 800);
        }
      } else if (++tries > 40) window.clearInterval(tick);
    }, 100);
    return () => window.clearInterval(tick);
  }, [asked, root]);

  // The box says one short Code-specific line. The session screen sets its own placeholder (and again whenever its mode changes),
  // so it is put back whenever that happens rather than once.
  useEffect(() => {
    const el = chatEl.current;
    if (!el) return;
    const fit = () => {
      const box = el.querySelector<HTMLTextAreaElement>("textarea");
      if (box && box.placeholder !== hint && !box.disabled) box.placeholder = hint;
    };
    fit();
    const watch = new MutationObserver(fit);
    watch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["placeholder"] });
    return () => watch.disconnect();
  }, [sid, app, hint, root]);

  const here = all.filter((c) => root && sameFolder(c.folder, root));
  const elsewhere = all.filter((c) => !root || !sameFolder(c.folder, root));
  const folderName = (f: string) => f.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || f;
  const pick = (c: CodeChat) => {
    setMovedOn(null);
    // Opened again from history: the chat is here, so a "With <mate>" tab for it no longer says where it is.
    dismissMoved(c.sid);
    if (!root || !sameFolder(c.folder, root)) setIdeRoot(c.folder);
    showCodeChat(c.folder, c.sid);
  };
  const row = (c: CodeChat, sub?: string) => ({
    label: shortTitle(c.title, 48),
    ...(sub || c.linked || c.overnight ? { sub: [sub, c.linked ? "From Agents" : "", c.overnight ? c.ran : ""].filter(Boolean).join(" · ") } : {}),
    checked: c.sid === sid,
    onSelect: () => pick(c),
    action: { icon: "x" as const, label: `Remove “${c.title || "Untitled"}” from Code's chats`, onSelect: () => removeCodeChat(c.sid) },
  });

  // A starting point pressed in the empty state: its words go in the box, ready to send or add to.
  const suggest = (words: string) => {
    const el = chatEl.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (!el) return;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    el.value = "";
    set?.call(el, words);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
    el.setSelectionRange(words.length, words.length);
  };
  const body: ReactNode = !root ? (
    <div className="ia-empty ia-start">
      <span className="ia-hero" aria-hidden="true"><Icon name="folder" size={20} /></span>
      <p className="ia-empty-title">Open a folder to start</p>
      <p>Chats here work on the code in the folder the IDE has open.</p>
      {missed && (
        <p className="ia-missed" role="status">
          <span title={missed}>“{folderName(missed)}”</span> was open last time, but it isn't there now.
          <button type="button" className="ia-link" onClick={dismissMissedFolder}>Dismiss</button>
        </p>
      )}
      <button type="button" className="ia-btn" onClick={() => window.dispatchEvent(new Event("friday:ide-open-folder"))}>
        <Icon name="folder" size={13} /> Open Folder
      </button>
    </div>
  ) : !app ? (
    <div className="ia-empty">
      <p>The chat isn't available here.</p>
    </div>
  ) : movedShown ? (
    movedShown.mate ? <WithMatePanel chat={movedShown} onClose={() => (dismissMoved(movedShown.sid), setMovedOn(null))} /> : <MovedPanel chat={movedShown} onClose={() => (dismissMoved(movedShown.sid), setMovedOn(null))} />
  ) : askShown ? (
    <AskPanel key={askShown.id} tab={askShown} root={root} identity={app.identity} onOpenFile={onOpenFile} />
  ) : sid && chat ? (
    <div className="ia-chat" ref={chatEl}>{app.chat(sid, chat.invite)}</div>
  ) : (
    <div className="ia-chat ia-new" ref={chatEl}>
      <div className="ia-new-lede ia-start">
        <span className="ia-hero" aria-hidden="true"><Icon name="chat" size={20} /></span>
        <p className="ia-empty-title">What should we work on?</p>
        <span className="ia-folder" title={root}><Icon name="folder" size={12} />{folderName(root)}</span>
        <div className="ia-suggest" role="group" aria-label="Starting points">
          <TicketPick identity={app.identity} folder={root} onPick={(url) => suggest(ticketText(url))} />
          {STARTERS.map((s) => (
            <button key={s.label} type="button" className="ia-suggest-row" onClick={() => suggest(s.text)}>
              <Icon name={s.icon} size={14} />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <p className="ia-tip"><kbd>{MAC ? "⌘L" : "Ctrl+L"}</kbd> in the IDE sends the lines you select</p>
      </div>
      {app.start(root)}
    </div>
  );

  // Each tab's mark: the coding tool its chat runs on, as last seen at work, else the one it was started with.
  const toolOf = (c: CodeChat) => ((app?.agentOf(c.sid) || c.tool || "") as EngineTool | "");
  return (
    <aside className="ide-agent" aria-label="Agent chat">
      <header className="ia-head">
        {/* The chats open in this folder, as tabs (Arun, 2026-11-19: "make it tabbed chats instead of just one on the panel, and
            shorten the chat title too"). Closing one keeps it in the history. */}
        <div className="ia-tabs" role="tablist" aria-label="Open chats">
          {tabs.map((c) => {
            const on = c.sid === sid && !over;
            const tool = toolOf(c);
            return (
              <div key={c.sid} role="tab" aria-selected={on} tabIndex={on ? 0 : -1} className={`ia-tab${on ? " on" : ""}`} title={tool ? `${c.title || "Untitled"} · ${ENGINE_NAMES[tool]}` : c.title || "Untitled"} onClick={() => pick(c)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick(c))} onAuxClick={(e) => e.button === 1 && closeCodeTab(root, c.sid)}>
                <span className="ia-tab-mark" aria-hidden="true">{tool ? <EngineMark tool={tool} size={13} /> : <Icon name="chat" size={13} />}</span>
                <span className="ia-tab-name">{shortTitle(c.title)}</span>
                {(c.linked || c.overnight) && <span className="ia-tab-from" title={c.linked ? "An Agents session, opened here" : c.ran}>{c.linked ? "Agents" : <Icon name="moon" size={10} />}</span>}
                <button type="button" className="ia-tab-x" aria-label={`Close “${shortTitle(c.title)}”`} title="Close (it stays in the history)" onClick={(e) => (e.stopPropagation(), closeCodeTab(root, c.sid))}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            );
          })}
          {movedTabs.map((m) => (
            <div key={m.sid} role="tab" aria-selected={m.sid === movedOn} tabIndex={0} className={`ia-tab ia-tab-moved${m.sid === movedOn ? " on" : ""}`} title={m.mate ? `“${m.title || "Untitled"}” is with ${m.mate.name}` : `“${m.title || "Untitled"}” moved to Agents`} onClick={() => setMovedOn(m.sid)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setMovedOn(m.sid))}>
              <span className="ia-tab-mark" aria-hidden="true">{m.mate ? <Face seed={m.mate.look ?? m.mate.name} size={14} /> : <Icon name="arrowUpRight" size={13} />}</span>
              <span className="ia-tab-name">{m.mate ? `With ${m.mate.name.split(/\s+/)[0]}` : "Moved to Agents"}</span>
              <button type="button" className="ia-tab-open" onClick={(e) => (e.stopPropagation(), m.mate ? openMateThread(m) : openInAgents(m))}>open</button>
              <button type="button" className="ia-tab-x" aria-label="Close this tab" title="Close" onClick={(e) => (e.stopPropagation(), dismissMoved(m.sid), m.sid === movedOn && setMovedOn(null))}>
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
          <AskTabs tabs={askTabs} on={askShown?.id ?? null} onPick={(id) => (setMovedOn(null), setAskOn(id))} onClose={(id) => (closeAsk(id), id === askOn && setAskOn(null))} />
          {root && !sid && !over && (
            <div role="tab" aria-selected className="ia-tab on" tabIndex={0}>
              <span className="ia-tab-mark" aria-hidden="true"><Icon name="chat" size={13} /></span>
              <span className="ia-tab-name">New chat</span>
            </div>
          )}
          {!root && (
            <div role="tab" aria-selected className="ia-tab on" tabIndex={0}>
              <span className="ia-tab-name">Chat</span>
            </div>
          )}
        </div>
        <div className="ia-head-acts">
          {sid && !over && (
            <button type="button" className="ia-icon" aria-label="Review changes" title="Review this branch's changes in the IDE" onClick={() => window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: "reviewChanges" }))}>
              <Icon name="columns" size={14} />
            </button>
          )}
          {sid && !over && (
            <button type="button" className="ia-icon" aria-label="Self-review" title={reviewNote || "The agent reviews its own diff before the pull request"} disabled={reviewing} onClick={() => {
              // Arun, 2026-11-19: "The agent reviews its own diff the way a senior engineer would… and fixes what it finds before you see it".
              // To this chat's session only (Code's column stays mounted beside Agents), and what came of it said, not dropped.
              setReviewing(true);
              setReviewNote("");
              const ask: AskLane = { lane: MAIN_LANE, sid, text: SELF_REVIEW_ASK, reply: (r) => { setReviewing(false); setReviewNote(r.ok ? "" : r.error || "That didn't send"); } };
              window.dispatchEvent(new CustomEvent("friday:ask-lane", { detail: ask }));
              if (!ask.handled) { setReviewing(false); setReviewNote("Open the chat to send that"); }
            }}>
              <Icon name="shield" size={14} />
            </button>
          )}
          {sid && chat && !over && app && (
            // "More": Send to Agents, then the Crew's teammates to hand the chat to (hand-to-mate.tsx). The wrapper is where the
            // palette finds the button (palette-run.ts).
            <div className="ia-hand">
              <HandMenu identity={app.identity} busy={!!away} onPick={handAway} onSend={sendAway} />
            </div>
          )}
          {root && (
            <button type="button" className="ia-icon" aria-label="New chat" title="New chat" disabled={!sid && !over} onClick={() => (setMovedOn(null), showCodeChat(root, "new"))}>
              <Icon name="plus" size={14} />
            </button>
          )}
          {(all.length > 0 || !!rewindable?.turns.length) && (
            <MenuButton
              className="ia-icon"
              icon="clock"
              label="Code chats"
              end
              maxHeight={420}
              items={() => [
                ...(over ? [] : checkpointItems(sid)),
                here.length > 0 && { heading: root ? `In ${folderName(root)}` : "Chats" },
                ...here.map((c) => row(c)),
                elsewhere.length > 0 && { heading: "Other folders" },
                ...elsewhere.slice(0, 30).map((c) => row(c, folderName(c.folder))),
              ]}
            />
          )}
          {onClose && (
            <button type="button" className="ia-icon" aria-label="Hide the chat" title={`Hide the chat (${MAC ? "⌘⌥B" : "Ctrl+Alt+B"})`} onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </header>
      {/* After a rewind: how many files went back, and Redo, until the next message (rewind-column.tsx). */}
      {sid && !over && <RewoundBar sid={sid} />}
      {away && away.sid === sid && !over && (
        <div className="ia-from" role="status">
          <span className="ia-from-text">{away.text}</span>
        </div>
      )}
      {reviewNote && <div className="ia-review-note" role="status">Self-review: {reviewNote}</div>}
      {/* A tool cut off by Friday closing: carry on or leave it (ide/RestoreBar.tsx; Arun, 2026-11-19: "agents that were running"). */}
      {root && app && !over && <RestoreBar identity={app.identity} tabs={tabs} shown={sid ?? undefined} toolOf={toolOf} />}
      {/* A tool heading for its usage limit: hand on now or later; or it ran out and the work went on (ide/limit-bar.tsx; Arun, 2026-11-20). */}
      {sid && app && !over && <Suspense fallback={null}><LimitBar identity={app.identity} sid={sid} /></Suspense>}
      {/* An Agents session opened here (Open in Code, ⌘E): still Agents' own until it is moved (Arun, 2026-11-19: "ensure code and
          agent platform can be interconnected and streamlined for easy passing of work"). */}
      {chat?.linked && !askShown && (
        <div className="ia-from" role="group" aria-label="From Agents">
          <button type="button" className="ia-from-btn" title="Make it one of Code's chats: it leaves Agents' list" onClick={() => (setMoved(chat.sid), moveToCode(chat.sid))}>Move to Code</button>
          <button type="button" className="ia-from-btn" title={`Back to this session in Agents (${MAC ? "⌘E" : "Ctrl+E"})`} onClick={() => swapMode()}>Back to Agents</button>
        </div>
      )}
      {/* Started by Run later (ide/later.ts): the night's work, there to read in the morning. */}
      {chat?.overnight && !askShown && (
        <div className="ia-from ia-night">
          <span className="ia-from-text">{chat.ran} · started {new Date(chat.overnight!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        </div>
      )}
      {/* Just moved: a way back, until another chat is shown. */}
      {chat && !chat.linked && moved === chat.sid && !askShown && (
        <div className="ia-from" role="group" aria-label="Moved to Code">
          <span className="ia-from-text">Moved to Code</span>
          <button type="button" className="ia-from-btn" title="Hand it back to Agents' list" onClick={() => (setMoved(null), handBack(chat.sid))}>Undo</button>
        </div>
      )}
      {body}
      {/* The IDE's status bar, carried on under this column, so the footer runs the window's width and the chat sits above it, as
          the IDE's own side panels do (Arun, 2026-11-19: "make sure the chat panel stays above the footer part"). */}
      <footer className="ia-foot">
        <TaskLine identity={app?.identity ?? null} />
      </footer>
      {root && app && quiet.map((q) => (
        <div key={q.id} hidden aria-hidden="true">
          {app.start(root, q)}
        </div>
      ))}
    </aside>
  );
}
