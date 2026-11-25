/**
 * The Captain's window, its settings and the New Captain sheet: loaded the first time one opens, so the sidebar's Captains don't
 * weigh on the first screen (2026-11-25: the first load went 2 KB over its budget with the simple window).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { ChatLine, Manager, ManagerAct, ManagerLevel, ManagerTask } from "../managers.js";
import { ENGINE_MODEL_INFO, ENGINE_NAMES, type EngineTool } from "../types.js";
import { AgentModelPicker, wordOf } from "./AgentModelPicker.js";
import { EngineMark } from "./BrandMarks.js";
import { useEngineModelInfo } from "./EngineModelPill.js";
import { useMachine } from "./local.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { MenuButton, Picker, Switch, useConfirm } from "./ui.js";
import { md } from "./markdown.js";
import { Shine } from "./shine.js";
import { ArrowUpIcon } from "lucide-react";
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from "@/components/ai-elements/prompt-input";
import { clockOf, forYouOf, managerFor, readyFacts, ManagerFace, type ManagedProject, type ManagerView, type ManagersApi } from "./Managers.js";

/** One of Run's options as a small on/off chip: a switch to a screen reader, its words always showing. */
function RunChip({ on, onChange, label, children }: { on: boolean; onChange: (v: boolean) => void; label: string; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={`mgr-chip${on ? " on" : ""}`} onClick={() => onChange(!on)}>
      <Icon name={on ? "check" : "plus"} size={11} />
      {children}
    </button>
  );
}
/**
 * What it did while you were away (managers.ts awayReport, here because that file reaches for node modules): what it decided, what's
 * ready, what still waits on you. Null when there's no Away or nothing happened in it.
 */
function awayOf(m: ManagerView, now = Date.now()): { decided: ManagerAct[]; ready: number; waiting: number; held: number } | null {
  const a = m.away;
  if (!a) return null;
  const end = a.back ?? now;
  const inside = (at: number) => at >= a.since && at <= end;
  const decided = m.log.filter((x) => x.kind === "assumed" && inside(x.at));
  const ready = (m.ready ?? []).filter((r) => inside(r.at)).length;
  const waiting = forYouOf(m, now).filter((x) => inside(x.at)).length;
  const held = m.log.filter((x) => (x.kind === "skipped" || x.kind === "sent-back") && inside(x.at) && !/^Just looked/.test(x.text)).length;
  return decided.length || ready || waiting || held ? { decided, ready, waiting, held } : null;
}

/**
 * Its panel, from its strip, its face or Home (Arun, 2026-11-25: "design the captain tab project pop overs better and more compact"):
 * two views in one popover. Now: what needs you, what's ready, its queue and the last things it did, with its model, today's
 * check-ins and its guard at the foot. Settings, from the gear: how much it does, what it runs on, its limits, its mascot, what it
 * knows, and Remove. Nothing you change once a week sits between you and what's happening.
 */
export function ManagerPanel({ m, p, api: a, onClose, onSettings }: { m: ManagerView; p: ManagedProject | undefined; api: ManagersApi; onClose: () => void; /** Its settings, in a modal of their own (2026-11-25: "make it a modal instead"). */ onSettings: () => void }) {
  return (
    <div className={`mgr-panel${m.on ? "" : " is-off"}`} data-testid="manager-panel" data-view="now">
      <header className="mgr-p-head">
        <ManagerFace m={m} size={28} />
        <div className="mgr-p-id">
          <div className="mgr-p-name" title={m.project.folder}>
            {m.project.name}
          </div>
          <span className="mgr-p-state" data-testid="captain-state">{captainState(m)}</span>
        </div>
        {/* A new conversation, and the ones before it. */}
        {m.on && (
          <MenuButton
            className="mgr-p-gear"
            label="Conversations"
            icon="more"
            end
            compact
            width={260}
            items={() => [
              { label: "New conversation", icon: "plus" as const, disabled: !(m.chat ?? []).length, onSelect: () => void a.newChat(m.id) },
              ...((m.pastChats ?? []).length ? [{ heading: "Earlier" }, ...(m.pastChats ?? []).map((c) => ({ label: c.title, sub: sameDay(c.at, Date.now()) ? clockOf(c.at) : new Date(c.at).toLocaleDateString([], { month: "short", day: "numeric" }), onSelect: () => void a.openChat(m.id, c.at), action: { icon: "trash" as const, label: `Delete "${c.title}"`, onSelect: () => void a.deleteChat(m.id, c.at) } }))] : []),
            ]}
          />
        )}
        <button type="button" className="mgr-p-gear" onClick={onSettings} aria-label="Captain settings" aria-haspopup="dialog" title="Settings">
          <Icon name="settings" size={15} />
        </button>
        <button type="button" className="mgr-p-gear mgr-p-close" onClick={onClose} aria-label="Close" title="Close">
          <Icon name="x" size={15} />
        </button>
      </header>
      {/* No How it works page (2026-11-25: "get rid of this page"): the settings' level cards say it. */}
      <PanelNow m={m} a={a} onClose={onClose} onSettings={onSettings} />
    </div>
  );
}

/** A goal's progress in a line (managers.ts goalLine, here because that file reaches for node modules): "2 of 3 ready · 1 shipped". */
type Goal = NonNullable<Manager["goals"]>[number];
/** 41k, 1.2M, 830: tokens the short way. */
const tokensText = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
/** ~$0.04, <$0.01: about what it cost. */
const usdText = (usd: number) => (usd < 0.01 ? "<$0.01" : `~$${usd < 10 ? usd.toFixed(2) : usd.toFixed(0)}`);
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const sinceText = (at: number) => {
  const m = Math.max(1, Math.round((Date.now() - at) / 60_000));
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};

/**
 * The Captain's window, simple (Arun, 2026-11-25: "we need to simplify and make this so easy for people to use... I don't really get
 * an immediate value out of trying it out", then "make it so easy but so good and understandable"). One column, one loop: you say
 * what should get done, it does it, and it hands it back ready. What needs you is pinned on top; the first thing it says is what it
 * sees and the obvious next step; each thing you ask is a card in the conversation that moves on its own; the box is at the foot.
 */
function PanelNow({ m, a, onClose }: { m: ManagerView; a: ManagersApi; onClose: () => void; onSettings: () => void }) {
  const asks = forYouOf(m);
  const ready = m.on ? (m.ready ?? []) : [];
  const open = (sid?: string) => sid && (dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid } })), onClose());
  const away = m.away?.back && !m.away.seen ? awayOf(m) : null;
  const awayOn = !!m.away && !m.away.back && m.away.until > Date.now();
  const [msg, setMsg] = useState("");
  const [sending, setSending] = useState(false);
  const run = m.level === "run";
  // Its conversation, less a day's digest line (the greeting says how things stand, live).
  const chat = (m.chat ?? []).filter((c) => !(c.who === "captain" && /^Today in .*:/i.test(c.text.trim())));
  const thinking = (m.chat ?? []).at(-1)?.who === "you";
  const scroller = useRef<HTMLDivElement>(null);
  // Each thread as it stands now, ready and waiting-on-you from its own record.
  const readySids = new Set(ready.map((r) => r.sid));
  const askSids = new Set(asks.map((x) => x.sid).filter(Boolean));
  const threads = (m.threads ?? []).map((t) => ({ ...t, state: t.state !== "needs" && askSids.has(t.sid) ? ("needs" as const) : (t.state === "idle" || t.state === "stopped") && readySids.has(t.sid) ? ("ready" as const) : t.state }));
  const working = threads.filter((t) => t.state === "working");
  const idle = threads.filter((t) => (t.state === "idle" || t.state === "stopped") && !readySids.has(t.sid));
  const waiting = threads.filter((t) => t.state === "needs");
  // What you asked for, as it stands: goals not given up, a finished one only on the day it finished.
  const goals = (m.goals ?? []).filter((g) => g.status !== "cancelled" && (g.status !== "done" || sameDay(g.at, Date.now())));
  const tasks = m.queue.filter((q) => !q.goal);
  const notices = (m.notices ?? []).filter((n) => n.kind === "risky" || n.kind === "overlap");
  const items: { at: number; key: string; chat?: ChatLine; goal?: Goal; task?: ManagerTask }[] = [
    ...chat.map((c) => ({ at: c.at, key: `c${c.at}${c.who}`, chat: c })),
    ...goals.map((g) => ({ at: g.at + 1, key: `g${g.id}`, goal: g })),
    ...tasks.map((t) => ({ at: t.at, key: `t${t.id}`, task: t })),
  ].sort((x, y) => x.at - y.at);
  useEffect(() => {
    // The conversation's end once there is one; before, the top, where what needs you is pinned.
    const el = scroller.current;
    if (el) el.scrollTop = items.length || thinking ? el.scrollHeight : 0;
  }, [items.length, thinking, m.id]);
  const say = (t: string) => {
    const text = t.trim();
    if (!text || sending) return;
    setSending(true);
    void a.say(m.id, text).then((ok) => (setSending(false), ok && setMsg("")));
  };

  if (!m.on)
    return (
      <div className="mgr-off" data-testid="captain-off">
        <p className="mgr-off-t">Off</p>
        <button type="button" className="btn primary small" onClick={() => void a.change(m.id, { on: true })}>
          Turn on
        </button>
      </div>
    );

  // The first thing it says, from how its threads stand now (no tokens): the count that matters most first, then the next step.
  const parts = [ready.length && `${ready.length} ready to ship`, waiting.length && `${waiting.length} waiting on you`, working.length && `${working.length} working`, idle.length && `${idle.length} sitting idle`].filter(Boolean) as string[];
  const lead = parts.length === 1 ? parts[0]!.replace(/^(\d+) /, (_, n) => `${n} thread${n === "1" ? "" : "s"} `) : (parts[0] ?? "");
  const rest = parts.slice(1);
  const unfinished = idle[0] ?? waiting[0];
  const greeting = !threads.length ? `No threads in ${m.project.name} yet.` : null;
  const quoted = (t: { title: string }) => `"${t.title}"`;
  const finishAll = idle.length > 1 ? `Finish the idle threads: ${idle.slice(0, 6).map(quoted).join(", ")}` : unfinished ? `Finish ${quoted(unfinished)}` : "";
  // The threads, what needs you first: waiting on you, ready, working, then idle; newest change first within each.
  const RANK = { needs: 0, ready: 1, working: 2, idle: 3, stopped: 3 } as const;
  const rows = [...threads].sort((x, y) => RANK[x.state] - RANK[y.state] || y.since - x.since);
  // Your last ask, for ↑ in an empty box.
  const lastSaid = [...(m.chat ?? [])].reverse().find((c) => c.who === "you")?.text ?? "";
  const focusBox = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".mgr-one-foot .mgr-composer-ta")?.focus());
  const quick = run ? ["What's left to do?", "Run the tests", "Review today's changes"] : ["What's left to do?", "What changed today?", "Anything risky?"];

  return (
    <div className="mgr-one">
      <div className="mgr-one-scroll" ref={scroller}>
        {/* What needs you, pinned: its questions, then work ready to ship, then a risky or overlapping change. */}
        {(asks.length > 0 || ready.length > 0 || notices.length > 0 || away || awayOn) && (
          <section className="mgr-pins" aria-label="For you">
            {away && (
              <div className="mgr-pin" data-testid="captain-away">
                <span className="mgr-pin-t">
                  While you were away: {away.decided.length} decided{away.ready ? `, ${away.ready} ready` : ""}
                  {away.decided.length > 0 && <em>{away.decided.slice(0, 2).map((x) => x.text.replace(/^Decided:\s*/i, "")).join(" · ")}</em>}
                </span>
                <button type="button" className="mgr-rc-no" onClick={() => void a.awaySeen(m.id)}>
                  Got it
                </button>
              </div>
            )}
            {awayOn && (
              <div className="mgr-pin quiet">
                <span className="mgr-pin-t">Away until {clockOf(m.away!.until)}</span>
              </div>
            )}
            {asks.slice(0, 3).map((x) => (
              <ForYou key={x.at} text={x.text} onAnswer={(t) => a.answer(m.id, x.at, t)} onDismiss={() => void a.answer(m.id, x.at, null)} />
            ))}
            {ready.slice(0, 3).map((r) => (
              <div key={`${r.sid}:${r.lane}`} className="mgr-pin ready" data-testid="captain-ready" title={r.summary.join(" ")}>
                <span className="mgr-pin-t">
                  {r.title}
                  <em>{readyFacts(r)}</em>
                </span>
                <button type="button" className="mgr-rc-go" onClick={() => open(r.sid)}>
                  Review &amp; ship
                </button>
                <button type="button" className="mgr-x" aria-label={`Put away "${r.title}"`} title="Put away" onClick={() => void a.doneReady(m.id, r.sid, r.lane)}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
            {notices.slice(0, 2).map((n) => (
              <button key={n.id} type="button" className="mgr-pin ask" disabled={!n.sid} onClick={() => open(n.sid)} title={n.text}>
                <span className="mgr-pin-t">{n.text.replace(/"/g, "")}</span>
              </button>
            ))}
          </section>
        )}

        {/* What it sees, and the obvious next step, while you haven't said anything yet. */}
        {!chat.length && !thinking && (
          <section className="mgr-hello" aria-label="What it sees" data-testid="captain-hello">
            <p>
              {greeting ?? (
                <>
                  <b>{lead}</b>
                  {rest.length ? `, ${rest.join(", ")}` : ""}.{run && unfinished ? " Want me to finish them?" : ""}
                </>
              )}
            </p>
            {(ready.length > 0 || unfinished) && (
              <div className="mgr-hello-a">
                {!run && unfinished && (
                  <button type="button" className="mgr-rc-go" disabled={sending} onClick={() => void a.change(m.id, { level: "run" }).then((ok) => ok && say("Finish what's sitting idle"))}>
                    Let it finish them
                  </button>
                )}
                {run && unfinished && (
                  <button type="button" className="mgr-rc-go" disabled={sending} title={finishAll} onClick={() => say(finishAll)}>
                    {idle.length > 1 ? `Finish all ${idle.length}` : "Finish it"}
                  </button>
                )}
                {ready.length > 0 && (
                  <button type="button" className="mgr-rc-no" onClick={() => open(ready[0]!.sid)}>
                    {ready.length > 1 ? "Show me the ready ones" : "Show me the ready one"}
                  </button>
                )}
              </div>
            )}
            {rows.length > 0 && (
              <ul className="mgr-ths" aria-label="Threads">
                {rows.map((t) => (
                  <li key={t.sid} className={`mgr-th ${t.state}${run && (t.state === "idle" || t.state === "stopped") ? " can-finish" : ""}`}>
                    <button type="button" className="mgr-th-open" onClick={() => open(t.sid)} title={`Open "${t.title}"`}>
                      <i className="mgr-th-dot" aria-hidden />
                      <span className="mgr-th-t">{t.title}</span>
                      {t.tool && (
                        <span className="mgr-th-tool" title={ENGINE_NAMES[t.tool] ?? t.tool}>
                          <EngineMark tool={t.tool} size={12} />
                        </span>
                      )}
                      <span className="mgr-th-s">{t.state === "working" ? "Working" : t.state === "needs" ? "Needs you" : t.state === "ready" ? "Ready" : sinceText(t.since)}</span>
                    </button>
                    {run && (t.state === "idle" || t.state === "stopped") && (
                      <button type="button" className="mgr-th-go" disabled={sending} aria-label={`Finish "${t.title}"`} onClick={() => say(`Finish "${t.title}"`)}>
                        Finish
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* The conversation: what you said, what it said, and each thing you asked for as a card that moves on its own. */}
        <section className="mgr-talk" aria-label="Conversation" data-testid="captain-chat">
          {items.map((x) =>
            x.chat ? (
              x.chat.who === "you" ? (
                <div key={x.key} className="mgr-msg you" title={clockOf(x.chat.at)}>
                  {x.chat.text}
                </div>
              ) : (
                <div key={x.key} className="mgr-say">
                  <div className="mgr-msg captain md" title={clockOf(x.chat.at)} dangerouslySetInnerHTML={{ __html: md(x.chat.text) }} />
                  <CopyButton text={x.chat.text} />
                </div>
              )
            ) : x.goal ? (
              <GoalCard key={x.key} g={x.goal} m={m} open={open} onGiveUp={() => void a.giveUp(m.id, x.goal!.id)} onReview={() => scroller.current?.scrollTo({ top: 0, behavior: "smooth" })} />
            ) : (
              <div key={x.key} className="mgr-wait" aria-label="Up next">
                <i className="mgr-goal2-dot" />
                <span title={x.task!.text}>{x.task!.text}</span>
                <em>{run ? "Waiting to start" : "Starts on Run"}</em>
                <button type="button" className="mgr-x" aria-label={`Take "${x.task!.text}" off the queue`} onClick={() => void a.unqueue(m.id, x.task!.id)}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            ),
          )}
          {thinking && (
            <div className="mgr-msg captain thinking">
              <Shine>Thinking…</Shine>
            </div>
          )}
        </section>
      </div>
      <footer className="mgr-one-foot">
        {!chat.length && !thinking && !msg && (
          <div className="mgr-quick" aria-label="Quick asks">
            {quick.map((q) => (
              <button key={q} type="button" onClick={() => (setMsg(q), focusBox())}>
                {q}
              </button>
            ))}
          </div>
        )}
        <div className="composer-box mgr-composer">
          <PromptInput onSubmit={() => say(msg)} className="prompt">
            <PromptInputBody className="prompt-field relative block">
              <PromptInputTextarea aria-label="Message the Captain" className="mgr-composer-ta" autoFocus value={msg} onChange={(e) => setMsg(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" && !msg && lastSaid) (e.preventDefault(), setMsg(lastSaid));
                  else if (e.key === "Escape" && msg) (e.preventDefault(), e.stopPropagation(), setMsg(""));
                }} placeholder={run ? `What should get done in ${m.project.name}?` : `Ask about ${m.project.name}…`} disabled={sending} />
            </PromptInputBody>
            <PromptInputFooter>
              <div className="flex items-center gap-1 composer-send">
                <PromptInputSubmit status={sending ? "submitted" : undefined} disabled={sending || !msg.trim()} aria-label="Send" title={msg.trim() ? "Send" : "Write something first"}>
                  {sending ? undefined : <ArrowUpIcon className="size-4" />}
                </PromptInputSubmit>
              </div>
            </PromptInputFooter>
          </PromptInput>
        </div>
        {a.error && <p className="mgr-error">{a.error}</p>}
      </footer>
    </div>
  );
}

/** Copy a reply, said "Copied" for a moment. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="mgr-copy"
      aria-label={done ? "Copied" : "Copy"}
      title={done ? "Copied" : "Copy"}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
    >
      <Icon name={done ? "check" : "copy"} size={12} />
    </button>
  );
}


/** How the Captain stands, in a few words beside its name: what needs you, else what's working, else what it watches. */
function captainState(m: ManagerView): string {
  if (!m.on) return "Off";
  const forYou = forYouOf(m).length + (m.ready?.length ?? 0);
  if (forYou) return `${forYou} for you`;
  const working = (m.threads ?? []).filter((t) => t.state === "working").length;
  if (working) return `${working} working`;
  const n = (m.threads ?? []).length;
  return n ? `Watching ${n} thread${n === 1 ? "" : "s"}` : "Watching";
}

/**
 * A Captain's settings, in a modal of their own laid out as the setup sheet (2026-11-25: "make it a modal instead.... because we
 * are cramping so much stuff in one place"): how much it does, what it runs on, its limits, its mascot, what it knows, and Remove.
 * Every change saves as it's made.
 */
export function CaptainSettings({ m, a, open, onClose, onBack }: { m: ManagerView; a: ManagersApi; open: boolean; onClose: () => void; /** Back to its window, when opened from there (2026-11-25: "add a back button to go back to the main captain modal"). */ onBack?: () => void }) {
  const [confirm, confirming] = useConfirm();
  const set = (body: Record<string, unknown>) => void a.change(m.id, body);
  const quiet = QUIET.find((q) => (q.q && m.quiet ? q.q.from === m.quiet.from && q.q.to === m.quiet.to : !q.q && !m.quiet))?.value ?? "none";
  const budgets = [...new Set([20, 40, 80, m.dailyWakes])].sort((x, y) => x - y);
  // What it spent today, from its own turns (2026-11-25: "optimized for cost"): nothing shown on a new day.
  const spend = m.spend && m.spend.day === new Date().toLocaleDateString("en-CA") && m.spend.turns > 0 ? m.spend : null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="mgr-setup mgr-settings max-w-[440px] p-0 gap-0 max-h-[calc(100vh-32px)] overflow-y-auto" data-testid="captain-settings">
        <div className="mgr-s-head">
          {onBack && (
            <button type="button" className="mgr-p-gear mgr-s-back" onClick={onBack} aria-label="Back to the Captain" title="Back">
              <Icon name="arrowLeft" size={15} />
            </button>
          )}
          <ManagerFace m={m} size={36} />
          <div className="min-w-0 flex-1">
            {/* No on switch here: that lives in its popover (2026-11-25: "get rid of the toggle here"). */}
            <DialogTitle className="mgr-s-title">{m.project.name}'s Captain</DialogTitle>
            <DialogDescription className="sr-only">Changes save as you make them.</DialogDescription>
          </div>
        </div>
        {/* Three choices, the rest under More (2026-11-25: "make it so easy but so good and understandable"). */}
        <div className="mgr-s-body">
          <div className="mgr-s-row">
            <span className="mgr-s-kk">
              <b>On</b>
              <span>Watches {m.project.name}'s threads</span>
            </span>
            <Switch on={m.on} onChange={(on) => set({ on })} label={m.on ? "Turn the Captain off" : "Turn the Captain on"} />
          </div>
          <div className="mgr-s-row">
            <span className="mgr-s-kk">
              <b>Start work by itself</b>
              <span>{m.level === "run" ? "Starts, checks and finishes what you ask" : "Off: it only tells you"}</span>
            </span>
            <Switch on={m.level === "run"} onChange={(v) => set({ level: v ? "run" : "help" })} label="Start work by itself" />
          </div>
          <div className="mgr-s-row" aria-label="Runs on" role="group">
            <span className="mgr-s-kk">
              <b>Runs on</b>
            </span>
            <RunsOn identity={a.identity} tool={m.tool} model={m.model} stepUp={m.stepUp} onChange={(v) => set(v)} />
          </div>
          <details className="mgr-s-more">
            <summary>More</summary>
            <div className="mgr-s-row">
              <span className="mgr-s-k">New threads</span>
              <ThreadTool identity={a.identity} value={m.threadTool ?? ""} onChange={(v) => set({ threadTool: v })} />
            </div>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">On its own</span>
              <div className="mgr-chips" role="group" aria-label="On Run">
                <RunChip on={m.startThreads} onChange={(v) => set({ startThreads: v })} label="Start new threads by itself">
                  Starts threads
                </RunChip>
                <RunChip on={m.startQueued} onChange={(v) => set({ startQueued: v })} label="Start the next queued task">
                  Starts queued
                </RunChip>
                <RunChip on={m.checkWork !== false} onChange={(v) => set({ checkWork: v })} label="Check finished work and send failures back">
                  Checks work
                </RunChip>
                <RunChip on={m.splitWork !== false} onChange={(v) => set({ splitWork: v })} label="Split big tasks into parts">
                  Splits big tasks
                </RunChip>
                <RunChip on={m.tidyIdle !== false} onChange={(v) => set({ tidyIdle: v })} label="Stop idle threads' tools and clear finished parts">
                  Tidies idle
                </RunChip>
              </div>
            </div>
            <div className="mgr-s-row">
              <span className="mgr-s-k">Limits</span>
              <div className="mgr-s-limits">
                <Picker label="Daily budget" value={m.dailyWakes} options={budgets.map((n) => ({ value: n, label: `${n} check-ins a day` }))} onChange={(n) => set({ dailyWakes: n })} />
                <Picker label="Quiet hours" value={quiet} options={QUIET.map((q) => ({ value: q.value, label: q.label }))} onChange={(v) => set({ quiet: QUIET.find((q) => q.value === v)?.q ?? null })} />
              </div>
            </div>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">Mascot</span>
              <LookPicker value={m.look} onChange={(look) => set({ look })} size={22} />
            </div>
            {spend && (
              <div className="mgr-s-row">
                <span className="mgr-s-k">Today</span>
                <span className="mgr-s-spend">
                  {spend.turns} turn{spend.turns === 1 ? "" : "s"} · {tokensText(spend.tokens)} tokens · {usdText(spend.usd)}
                </span>
              </div>
            )}
          </details>
        </div>
        {a.error && <p className="mgr-error mgr-s-err">{a.error}</p>}
        <div className="mgr-s-foot">
          <span className="mgr-p-guard" title="PRs, merges, pushes to main, deploys, money and messages as you always wait for you">
            <Icon name="shield" size={12} />
            Never approves PRs, merges, deploys or money
          </span>
          <button type="button" className="btn ghost mgr-remove-btn" onClick={() => confirm({ title: `Remove ${m.project.name}'s Captain?`, body: "Its threads keep running. Its queue and what it did go with it.", action: "Remove", onConfirm: () => void a.remove(m.id).then(onClose) })}>
            Remove
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
        {confirming}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A thread's finished work, checked, as a compact result card (memory: result-cards-design): a tile, its title, one facts line,
 * how risky it reads and Review & ship, which opens the thread, where its Ship makes the pull request on your press, never the
 * Captain's. What changed and where to look are on hover.
 */
/** A goal's pieces in order, for its bar and rows: its threads as they stand, then its tasks still waiting to start. */
type Piece = { key: string; state: "shipped" | "ready" | "running" | "stuck" | "waiting" | "quiet"; text: string; sid?: string; tool?: EngineTool };
const PIECE_WORD: Record<Piece["state"], string> = { shipped: "Shipped", ready: "Ready", running: "Working", stuck: "Stuck", waiting: "Waiting to start", quiet: "Quiet" };
const GOAL_PILL: Record<Goal["status"], string> = { working: "Working", ready: "Ready for you", done: "Done", stuck: "Stuck", cancelled: "Given up" };


function GoalCard({ g, m, open, onGiveUp, onReview }: { g: Goal; m: ManagerView; open: (sid?: string) => void; onGiveUp: () => void; onReview: () => void }) {
  const byId = new Map((m.threads ?? []).map((t) => [t.sid, t]));
  const pieces: Piece[] = [
    // Each thread as it stands now (its live state over the goal's record): running only while it really runs, waiting on you as stuck.
    ...g.threads.map((t) => {
      const live = byId.get(t.sid);
      const state: Piece["state"] = t.state === "shipped" || t.state === "ready" ? t.state : live?.state === "working" ? "running" : live?.state === "needs" || t.state === "stuck" ? "stuck" : live ? "quiet" : t.state;
      return { key: t.sid, state, text: live?.title || t.task, sid: t.sid, ...(live?.tool ? { tool: live.tool } : {}) } as Piece;
    }),
    ...m.queue.filter((q) => q.goal === g.id).map((q) => ({ key: q.id, state: "waiting" as const, text: q.text })),
  ];
  const count = (st: Piece["state"]) => pieces.filter((x) => x.state === st).length;
  const readyN = count("ready") + count("shipped");
  const summary = pieces.length
    ? [`${readyN} of ${pieces.length} ready`, count("running") && `${count("running")} working`, count("stuck") && `${count("stuck")} stuck`, count("waiting") && `${count("waiting")} waiting to start`].filter(Boolean).join(" · ")
    : "Planning the threads…";
  // Its state from its pieces as they stand, so it never says Working with nothing running.
  const pill = count("running") ? `Working · ${sinceText(g.at)}` : count("stuck") ? "Stuck" : g.status === "ready" ? GOAL_PILL.ready : !pieces.length ? "Planning…" : count("waiting") ? "Waiting to start" : g.status === "working" ? "Quiet" : GOAL_PILL[g.status];
  const tone = count("running") ? "working" : count("stuck") ? "stuck" : g.status === "ready" ? "ready" : "idle";
  return (
    <div className={`mgr-goal2 ${tone}`} data-testid="captain-goal">
      <div className="mgr-goal2-top">
        <span className="mgr-goal2-pill">{pill}</span>
        <button type="button" className="mgr-x" aria-label={`Give up "${g.title}"`} title="Give up: its tasks not yet started go; its threads stay" onClick={onGiveUp}>
          <Icon name="x" size={11} />
        </button>
      </div>
      <b className="mgr-goal2-t">{g.title}</b>
      <div className="mgr-goal2-bar" aria-hidden>
        {pieces.length ? pieces.map((x) => <i key={x.key} className={x.state} />) : <i className="planning" />}
      </div>
      {pieces.length !== 1 && <div className="mgr-goal2-sum">{summary}</div>}
      {pieces.length > 0 && (
        <div className="mgr-goal2-rows">
          {pieces.map((x) => (
            <button key={x.key} type="button" className={`mgr-goal2-row ${x.state}`} disabled={!x.sid} onClick={() => open(x.sid)} title={x.text}>
              <i className={`mgr-goal2-dot ${x.state}`} />
              <span className="mgr-goal2-rt">{x.text}</span>
              {x.tool ? <EngineMark tool={x.tool} size={12} /> : <span />}
              <span className="mgr-goal2-rs">{PIECE_WORD[x.state]}</span>
            </button>
          ))}
        </div>
      )}
      {g.status === "ready" && (
        <div className="mgr-rc-a">
          <button type="button" className="mgr-rc-go" onClick={onReview}>
            Review what&apos;s ready
          </button>
        </div>
      )}
    </div>
  );
}


/** One of its questions for you: what it asks, a line to answer it (passed on by the Captain to its thread), or put it away. */
function ForYou({ text, onAnswer, onDismiss }: { text: string; onAnswer: (t: string) => Promise<boolean>; onDismiss: () => void }) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  return (
    <div className="mgr-ask">
      <p className="mgr-ask-q">{text}</p>
      <button type="button" className="mgr-x mgr-ask-x" aria-label="Put this question away" title="Put away" onClick={onDismiss}>
        <Icon name="x" size={11} />
      </button>
      <form
        className="mgr-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          const t = reply.trim();
          if (!t || sending) return;
          setSending(true);
          void onAnswer(t).then((ok) => (setSending(false), ok && setReply("")));
        }}
      >
        <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Your answer" aria-label="Your answer" disabled={sending} />
        <button type="submit" className="mgr-send" aria-label="Send your answer" disabled={!reply.trim() || sending}>
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" size={12} />}
        </button>
      </form>
    </div>
  );
}


/** A tool's model for a Captain when none is picked: Haiku on Claude Code, else its first named model (as the server's captainModel). */
const defaultModel = (tool: EngineTool) => (tool === "claude" ? "haiku" : (ENGINE_MODEL_INFO[tool].find((m) => m.id !== "auto")?.id ?? "auto"));
const defaultStepUp = (tool: EngineTool) => (tool === "claude" ? "sonnet" : "");

/**
 * The coding tool a Captain runs on, its model, and the model it steps up to when something is hard (Arun, 2026-11-24: "be able
 * to select models from various coding tools and stuff as well for the captain"). Tools are the ones ready on this computer; models
 * are that tool's own list, as the composer's pill reads it. Friday's Auto isn't offered: a Captain runs on one model it can count.
 */
/**
 * What the threads a Captain starts run on (2026-11-25: "what agents it will select for use... only selecting Codex"): Auto, the
 * best fit for each task weighed by what you use in the project and what is already busy (managers pickThreadTool), or one of
 * the coding tools ready here.
 */
function ThreadTool({ identity, value, onChange }: { identity: Identity; value: EngineTool | ""; onChange: (v: EngineTool | "") => void }) {
  const { state } = useMachine(identity);
  const ready = state.tools.filter((f) => f.path && !f.unavailable && f.loggedIn !== false).map((f) => f.tool as EngineTool);
  const tools = value && !ready.includes(value) ? [value, ...ready] : ready;
  return (
    <Picker
      label="New threads run on"
      heading="New threads it starts run on"
      value={value}
      options={[{ value: "", label: "Auto", text: "Auto: best fit for each task", hint: "your habit here, what is busy" }, ...tools.map((t) => ({ value: t, label: ENGINE_NAMES[t] ?? t, mark: <EngineMark tool={t} size={13} /> }))]}
      onChange={(v) => onChange(v as EngineTool | "")}
    />
  );
}

function RunsOn({ identity, tool, model, stepUp, onChange }: { identity: Identity; tool: EngineTool; model: string; stepUp: string; onChange: (v: { tool?: EngineTool; model?: string; stepUp?: string }) => void }) {
  const { state } = useMachine(identity);
  const listed = useEngineModelInfo(tool, identity).filter((x) => x.id !== "auto");
  const models = listed.some((x) => x.id === model) ? listed : [{ id: model, label: model }, ...listed];
  const ups = stepUp && !models.some((x) => x.id === stepUp) ? [{ id: stepUp, label: stepUp }, ...models] : models;
  const hasLatest = ups.some((x) => (x as { group?: string }).group === "Latest");
  // The coding tool and its model as the app's one picker, as on the new-session page and a teammate's (2026-11-25: "use the
  // default model picker instead of the two seperate pickers for coding tool and model"): its own coding tools only, never
  // Friday Code (own={[]}), and the step-up beside it.
  const toolState = (t: EngineTool) => {
    const f = state.tools.find((x) => x.tool === t);
    return {
      disabled: !!f && (!f.path || !!f.unavailable),
      absent: !!f && !f.path,
      ready: !!f?.path && !f.unavailable && f.loggedIn !== false,
      hint: f ? (f.path ? (f.unavailable ? "not here yet" : f.loggedIn === false ? "sign in" : "ready") : "not installed") : "…",
    };
  };
  return (
    <div className="mgr-runs">
      <div className="mgr-runs-pick">
        <AgentModelPicker
          engine={tool}
          onEngine={(t) => t && t !== tool && onChange({ tool: t, model: defaultModel(t), stepUp: defaultStepUp(t) })}
          model={model}
          onModel={(v) => v && v !== "auto" && onChange(v === stepUp ? { model: v, stepUp: "" } : { model: v })} // a Captain runs on one model, never smart routing
          fridayModelId=""
          onFridayModel={() => {}}
          fridayName=""
          plan="free"
          identity={identity}
          toolState={toolState}
          own={[]}
        />
      </div>
      {/* The step-up, dense (2026-11-25: "design this better too information dense"): the tool's latest models only, each with
          its one word, and an older one only when it's the one picked; the field says "Steps up to …". */}
      <Picker above label="When it's unsure, it steps up to" heading="When it's unsure" value={stepUp === model ? "" : stepUp} options={[{ value: "", label: "Stays on its model", text: "Stays on its model" }, ...ups.filter((x) => x.id !== model && (!hasLatest || (x as { group?: string }).group === "Latest" || x.id === stepUp)).map((x) => ({ value: x.id, label: x.label, text: `Steps up to ${x.label}`, hint: wordOf((x as { blurb?: string }).blurb ?? "", x.id) }))]} onChange={(v) => onChange({ stepUp: v })} className="mgr-runs-up" />
    </div>
  );
}

/** Ten mascots to pick from: each seed makes its own colour, shape and eyes (teammate-face.tsx). */
const LOOKS = ["cap:ada", "cap:bo", "cap:cy", "cap:dee", "cap:eli", "cap:fay", "cap:gus", "cap:hal", "cap:ivy", "cap:jo"];
const shuffled = () => `cap:${Math.random().toString(36).slice(2, 9)}`;

/**
 * Picking a Captain's mascot (Arun, 2026-11-24: "be able to customize the managers mascot too"): ten to choose from and Shuffle
 * for a new one; the one it has now leads the row when it isn't one of the ten.
 */
function LookPicker({ value, onChange, size = 26 }: { value: string; onChange: (look: string) => void; size?: number }) {
  const row = LOOKS.includes(value) ? LOOKS : [value, ...LOOKS.slice(0, 9)];
  return (
    <div className="mgr-looks" role="radiogroup" aria-label="Its mascot">
      {row.map((l, i) => (
        <button key={l} type="button" role="radio" aria-checked={value === l} aria-label={`Mascot ${i + 1}`} className={value === l ? "on" : ""} onClick={() => onChange(l)}>
          <ManagerFace m={{ look: l, on: true }} size={size} />
        </button>
      ))}
      <button type="button" className="mgr-shuffle" onClick={() => onChange(shuffled())} aria-label="Shuffle for a new mascot" title="Shuffle">
        <Icon name="refresh" size={13} />
      </button>
    </div>
  );
}
const QUIET: { value: string; label: string; q: { from: number; to: number } | null }[] = [
  { value: "none", label: "No quiet hours", q: null },
  { value: "22-8", label: "Quiet 10 PM – 8 AM", q: { from: 22 * 60, to: 8 * 60 } },
  { value: "23-7", label: "Quiet 11 PM – 7 AM", q: { from: 23 * 60, to: 7 * 60 } },
];

/**
 * The sheet that sets up a Captain for one of the sidebar's projects (Arun, 2026-11-24: "more compact and simplier… selecting
 * project doesnt work"): the project and its face in one line, how much it does, and its limits as three small choices.
 */
export function ManagerSetup({ api: a, projects, initial, open, onClose }: { api: ManagersApi; projects: readonly { name: string; folder: string }[]; initial?: string; open: boolean; onClose: () => void }) {
  const free = projects.filter((p) => !managerFor(a.managers, p));
  const [project, setProject] = useState("");
  const [look, setLook] = useState(LOOKS[0]!);
  // On by default: what you ask, it starts, checks and finishes; it never ships or merges (2026-11-25: "immediate value").
  const [level, setLevel] = useState<ManagerLevel>("run");
  const [startThreads, setStartThreads] = useState(true);
  const [startQueued, setStartQueued] = useState(true);
  const [checkWork, setCheckWork] = useState(true);
  const [splitWork, setSplitWork] = useState(true);
  const [tidyIdle, setTidyIdle] = useState(true);
  const [daily, setDaily] = useState(40);
  const [quiet, setQuiet] = useState("none");
  const [tool, setTool] = useState<EngineTool>("claude");
  const [model, setModel] = useState("haiku");
  const [stepUp, setStepUp] = useState("sonnet");
  const [busy, setBusy] = useState(false);
  // Picked once as it opens, never again while it's open: the project list is rebuilt on every render of the sidebar, and an
  // effect on it put the first project back after each pick (2026-11-24: "selecting project doesnt work").
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setProject(initial && free.some((p) => p.name === initial) ? initial : (free[0]?.name ?? ""));
    wasOpen.current = open;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = free.find((p) => p.name === project) ?? free[0];
  const turnOn = () => {
    if (!pick) return;
    setBusy(true);
    void a.create({ folder: pick.folder, name: pick.name, look, level, startThreads, startQueued, checkWork, splitWork, tidyIdle, dailyWakes: daily, quiet: QUIET.find((q) => q.value === quiet)?.q ?? null, tool, model, stepUp }).then((ok) => (setBusy(false), ok && onClose()));
  };
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="mgr-setup max-w-[420px] p-0 gap-0 max-h-[calc(100vh-32px)] overflow-y-auto" data-testid="manager-setup">
        <div className="mgr-s-head">
          <ManagerFace m={{ look, on: true }} size={36} />
          <div className="min-w-0">
            <DialogTitle className="mgr-s-title">New Captain</DialogTitle>
            <DialogDescription className="mgr-s-sub">Minds a project's threads and gets things done.</DialogDescription>
          </div>
        </div>
        {!pick ? (
          <p className="mgr-s-none">Every project in your sidebar has a Captain. Start a thread in another folder to set one up there.</p>
        ) : (
          <div className="mgr-s-body">
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>Project</b>
              </span>
              <Picker label="Project" value={pick.name} options={free.map((p) => ({ value: p.name, label: p.name, sub: p.folder }))} onChange={setProject} className="mgr-s-pick" />
            </div>
            <div className="mgr-s-row">
              <span className="mgr-s-kk">
                <b>Start work by itself</b>
                <span>{level === "run" ? "Starts, checks and finishes what you ask" : "Off: it only tells you"}</span>
              </span>
              <Switch on={level === "run"} onChange={(v) => setLevel(v ? "run" : "help")} label="Start work by itself" />
            </div>
            <div className="mgr-s-row" aria-label="Runs on" role="group">
              <span className="mgr-s-kk">
                <b>Runs on</b>
              </span>
              <RunsOn
                identity={a.identity}
                tool={tool}
                model={model}
                stepUp={stepUp}
                onChange={(v) => {
                  if (v.tool) setTool(v.tool);
                  if (v.model !== undefined) setModel(v.model);
                  if (v.stepUp !== undefined) setStepUp(v.stepUp);
                }}
              />
            </div>
            <details className="mgr-s-more">
              <summary>More</summary>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">Mascot</span>
              <LookPicker value={look} onChange={setLook} size={22} />
            </div>
            <div className="mgr-s-row top">
              <span className="mgr-s-k">On its own</span>
                <div className="mgr-chips" role="group" aria-label="On Run">
                  <RunChip on={startThreads} onChange={setStartThreads} label="Start new threads by itself">
                    Starts threads
                  </RunChip>
                  <RunChip on={startQueued} onChange={setStartQueued} label="Start the next queued task">
                    Starts queued
                  </RunChip>
                  <RunChip on={checkWork} onChange={setCheckWork} label="Check finished work and send failures back">
                    Checks work
                  </RunChip>
                  <RunChip on={splitWork} onChange={setSplitWork} label="Split big tasks into parts">
                    Splits big tasks
                  </RunChip>
                  <RunChip on={tidyIdle} onChange={setTidyIdle} label="Stop idle threads' tools and clear finished parts">
                    Tidies idle
                  </RunChip>
                </div>
            </div>
            <div className="mgr-s-row">
              <span className="mgr-s-k">Limits</span>
              <div className="mgr-s-limits">
                <Picker label="Daily budget" value={daily} options={[20, 40, 80].map((n) => ({ value: n, label: `${n} check-ins a day` }))} onChange={setDaily} />
                <Picker label="Quiet hours" value={quiet} options={QUIET.map((q) => ({ value: q.value, label: q.label }))} onChange={setQuiet} />
              </div>
            </div>
            </details>
          </div>
        )}
        {a.error && <p className="mgr-error mgr-s-err">{a.error}</p>}
        <div className="mgr-s-foot">
          <span className="mgr-p-guard">
            <Icon name="shield" size={12} />
            Never approves PRs, merges, deploys or money
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!pick || busy} onClick={turnOn}>
            Turn on
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Captain's window and its settings, as ManagerPopover opens them (loaded with the first one opened). */
export function CaptainWindow({ m, p, api, open, onOpenChange, sheet, setSheet }: { m: ManagerView; p: ManagedProject | undefined; api: ManagersApi; open: boolean; onOpenChange: (v: boolean) => void; sheet: boolean; setSheet: (v: boolean) => void }) {
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Esc with something typed in the box clears the box (its own keydown); only an empty box closes the window.
          onEscapeKeyDown={(e) => { const t = document.activeElement; if (t instanceof HTMLTextAreaElement && t.classList.contains("mgr-composer-ta") && t.value) e.preventDefault(); }}
          className="mgr-pop mgr-modal mgr-one-modal max-w-[540px] sm:max-w-[540px] w-[calc(100vw-48px)] p-0 gap-0">
          <DialogTitle className="sr-only">{m.project.name}'s Captain</DialogTitle>
          <DialogDescription className="sr-only">What it's doing, what it needs from you, and a box to talk to it.</DialogDescription>
          <ManagerPanel m={m} p={p} api={api} onClose={() => onOpenChange(false)} onSettings={() => (onOpenChange(false), setSheet(true))} />
        </DialogContent>
      </Dialog>
      <CaptainSettings m={m} a={api} open={sheet} onClose={() => setSheet(false)} onBack={() => (setSheet(false), onOpenChange(true))} />
    </>
  );
}
