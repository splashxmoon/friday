import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, CheckIcon, ChevronRightIcon, PencilLineIcon, ShieldCheckIcon, Undo2Icon, BarChart3Icon, CircleDotIcon, CopyIcon, FileCodeIcon, FileDiffIcon, FileTextIcon, GitPullRequestIcon, GlobeIcon, HistoryIcon, LayoutGridIcon, LinkIcon, ListChecksIcon, MailIcon, MessageSquareIcon, type LucideIcon } from "lucide-react";
import { AtSignIcon, CalendarClockIcon, Columns2Icon, FlaskConicalIcon, ImagesIcon, ScaleIcon, TableIcon, TextCursorInputIcon, TrendingDownIcon, TrendingUpIcon, VideoIcon } from "./gen-ui-marks.js";
import { tickEvery } from "./presence.js";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { SessionState } from "../session/projection.js";
import { MAIN_LANE, type SessionEvent } from "../types.js";
import { answerText, fieldProblem, filled, pickText, testCounts, type ChangedFile, type CompareSide, type FormField, type LinkItem, type StatTile, type Tone, type UiAction, type UiCard } from "../gen-ui-model.js";
import { FileIcon } from "./fileIcons.js";
import { ideHint } from "./ide/mode.js";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DecisionCard } from "./decision-card.js";
import { localPicture } from "./LiveBlock.js";
import { SiteIcon } from "./WorkRail.js";
import type { Send } from "./useSession.js";
import { Picker } from "./ui.js";
import "./gen-ui.css";
import { Guard, GuardLine } from "./guard.js";

/**
 * A card an agent drew in the chat (gen-ui.ts show_ui): where it was first shown, as it is now (shown again
 * with its id, or changed with update_ui, the latest). Every press goes to that agent as the person's message, its plain words and
 * exactly what was pressed and filled in (instruction.card); a card the agent waits on hands it back to that very call.
 *
 * One card for every kind (Arun, 2026-11-17: "very advanced and beautiful generative UI in the chats... dynamic and interactive",
 * "GO ALL OUT"; the mock in Friday Work HQ product/designs/generative-ui-mock.html): its title and a line under it, the thing
 * itself, and a foot with what can be done; pressed, the foot says what was sent, and the card stays as it was answered.
 */
function GenCardDrawn({ ev, events, send, sid, invite }: { ev: SessionEvent; state: SessionState; events: SessionEvent[]; send: Send; sid: string; invite: string; stamp?: ReactNode }) {
  const id = ev.body.type === "ui.card" ? ev.body.id : "";
  const lane = ev.lane ?? MAIN_LANE;
  // Found once per new event, not on every redraw: the chat redraws on every word an agent streams.
  const same = useMemo(() => events.filter((e) => e.body.type === "ui.card" && e.body.id === id && (e.lane ?? MAIN_LANE) === lane), [events, id, lane]);
  const last = same.at(-1) ?? ev;
  const card = last.body.type === "ui.card" ? last.body.card : null;
  const answer = useMemo(() => (card ? answerOf(events, lane, ev.seq, id, card.title) : null), [events, lane, ev.seq, id, card]);
  const sender = useAnswer(card, id, lane, send);
  if (ev.body.type !== "ui.card" || !card) return null;
  if (same[0] && same[0].seq !== ev.seq) return null;
  // A kind no longer drawn (a plan or status card from before 2026-11-02) is nothing, not a broken card.
  if (!(card.kind in DRAW)) return null;
  const p: CardProps = { card, id, lane, seq: ev.seq, events, answer, sender, sid, invite, updatedAt: last.ts };
  return (
    <div className="gu-wrap" data-kind={card.kind}>
      {DRAW[card.kind](p)}
    </div>
  );
}

type Answer = { action: string; values: Record<string, string | string[]>; text: string };
type Sender = { sending: string | null; go: (action: string, label: string, values?: Record<string, string | string[]>, extra?: string[]) => void };
type CardProps = { card: UiCard; id: string; lane: string; seq: number; events: SessionEvent[]; answer: Answer | null; sender: Sender; sid: string; invite: string; updatedAt: number };

const DRAW: Record<UiCard["kind"], (p: CardProps) => ReactNode> = {
  choices: (p) => <Choices {...p} />,
  pictures: (p) => <Pictures {...p} />,
  changes: (p) => <Changes {...p} />,
  run: (p) => <Run {...p} />,
  select: (p) => <Select {...p} />,
  goahead: (p) => <GoAhead {...p} />,
  stats: (p) => <Stats {...p} />,
  draft: (p) => <Draft {...p} />,
  slots: (p) => <Slots {...p} />,
  matrix: (p) => <Matrix {...p} />,
  links: (p) => <Links {...p} />,
  file: (p) => <FileCard {...p} />,
  timeline: (p) => <Timeline {...p} />,
  table: (p) => (
    <Shell card={p.card}>
      <Table card={p.card} />
    </Shell>
  ),
  chart: (p) => (
    <Shell card={p.card}>
      <Chart card={p.card} />
    </Shell>
  ),
  compare: (p) => (
    <Shell card={p.card}>
      <Compare card={p.card} />
    </Shell>
  ),
  form: (p) => <Form {...p} />,
  sources: (p) => (
    <Shell card={p.card}>
      <Sources card={p.card} sid={p.sid} invite={p.invite} />
    </Shell>
  ),
};

/** The person's press on card `id` (drawn at `seq`): by the card it names, else (older cards) by its words' lead. */
function answerOf(events: SessionEvent[], lane: string, seq: number, id: string, title: string): Answer | null {
  const lead = pickText(title, "").trimEnd();
  for (const e of events) {
    if (e.seq <= seq || e.body.type !== "instruction" || e.actor.kind !== "human" || (e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.card?.id === id) return { action: e.body.card.action, values: e.body.card.values ?? {}, text: e.body.text };
    if (!e.body.card && e.body.text.startsWith(lead)) return { action: "pick", values: { option: e.body.text.slice(lead.length).split("\n")[0]!.trim() }, text: e.body.text };
  }
  return null;
}

/** Sends a press: the person's message on the agent's lane, its words and exactly what was pressed. */
function useAnswer(card: UiCard | null, id: string, lane: string, send: Send): Sender {
  const [sending, setSending] = useState<string | null>(null);
  return {
    sending,
    go: (action, label, values = {}, extra = []) => {
      if (!card || sending) return;
      setSending(label);
      void send({ type: "instruct", text: answerText(card, label, values, extra), lane, card: { id, action, values } } as Parameters<Send>[0]).then((r) => !r.ok && setSending(null));
    },
  };
}

/** Each kind's small mark at its head: what kind of thing it is, at a glance. */
type Mark = LucideIcon | ((p: React.SVGProps<SVGSVGElement>) => React.ReactElement);
const MARK: Partial<Record<UiCard["kind"], Mark>> = { pictures: ImagesIcon, changes: FileDiffIcon, run: FlaskConicalIcon, select: ListChecksIcon, goahead: ShieldCheckIcon, stats: BarChart3Icon, slots: CalendarClockIcon, matrix: ScaleIcon, links: LinkIcon, file: FileCodeIcon, timeline: HistoryIcon, table: TableIcon, chart: BarChart3Icon, compare: Columns2Icon, form: TextCursorInputIcon, sources: GlobeIcon };
const DRAFT_ON: Record<NonNullable<UiCard["channel"]>, { icon: Mark; word: string }> = { email: { icon: MailIcon, word: "Email" }, x: { icon: AtSignIcon, word: "Post on X" }, linkedin: { icon: LayoutGridIcon, word: "LinkedIn post" }, chat: { icon: MessageSquareIcon, word: "Chat message" }, post: { icon: PencilLineIcon, word: "Post" }, doc: { icon: FileTextIcon, word: "Doc" }, sms: { icon: MessageSquareIcon, word: "Text message" } };

/** The card every kind shares: its mark, title, a line under it, what sits at its right, then the thing, then its foot. */
function Shell({ card, aside, children, foot, className, tag }: { card: UiCard; aside?: ReactNode; children?: ReactNode; foot?: ReactNode; className?: string; tag?: ReactNode }) {
  const Mark = card.kind === "draft" ? DRAFT_ON[card.channel ?? "post"].icon : MARK[card.kind];
  return (
    <section className={cn("gc", className)} aria-label={card.title}>
      <header className="gc-head">
        {Mark && (
          <span className="gc-mark" aria-hidden="true">
            <Mark />
          </span>
        )}
        <div>
          <p className="gc-title">{card.title}</p>
          {card.note && <p className="gc-sub">{card.note}</p>}
        </div>
        {(aside || tag) && (
          <div className="gc-aside">
            {aside}
            {tag}
          </div>
        )}
      </header>
      {children}
      {foot}
    </section>
  );
}

function Foot({ meta, children }: { meta?: ReactNode; children?: ReactNode }) {
  return (
    <div className="gc-foot">
      <span className="gc-meta">{meta}</span>
      {children}
    </div>
  );
}

/** Pressed: what was sent, and that it went (or is going). */
function Sent({ text, sending }: { text: string; sending?: boolean }) {
  return (
    <div className="gc-sent" role="status">
      {sending ? <span className="ring-spin" aria-hidden="true" /> : <CheckIcon className="gc-tick" aria-hidden="true" />}
      <span className="gc-sent-txt">{text}</span>
      <span className="gc-sent-word">{sending ? "Sending…" : "Sent"}</span>
    </div>
  );
}

/** A foot's buttons: each its words; one that asks for a line opens one in place, sent with Enter. */
function Actions({ actions, onPress, disabled, meta, primaryLabel }: { actions: UiAction[]; onPress: (a: UiAction, note?: string) => void; disabled?: (a: UiAction) => boolean; meta?: ReactNode; primaryLabel?: (a: UiAction) => string }) {
  const [asking, setAsking] = useState<UiAction | null>(null);
  const [note, setNote] = useState("");
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => void (asking && field.current?.focus()), [asking]);
  return (
    <>
      {asking && (
        <form
          className="gc-note-in"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) onPress(asking, note.trim());
          }}
        >
          <PencilLineIcon className="gc-pen" aria-hidden="true" />
          <input ref={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder={asking.input} aria-label={asking.input} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setAsking(null), setNote(""))} />
          <button type="submit" className="gc-send" disabled={!note.trim()} aria-label="Send">
            <ArrowUpIcon aria-hidden="true" />
          </button>
        </form>
      )}
      <Foot meta={meta}>
        {actions.map((a) => (
          <button key={a.name} type="button" className={cn("gb", a.primary && "pri", asking?.name === a.name && "on")} disabled={disabled?.(a)} onClick={() => (a.input ? setAsking((x) => (x?.name === a.name ? null : a)) : onPress(a))}>
            {primaryLabel?.(a) ?? a.label}
          </button>
        ))}
      </Foot>
    </>
  );
}

const letter = (i: number) => String.fromCharCode(65 + i);

/** Choices: the decision card agents' questions get, its press going back as the card's answer. */
function Choices({ card, seq, answer, sender }: CardProps) {
  const options = (card.options ?? []).map((o) => o.label);
  const done = answer ? String(answer.values.option ?? answer.values.note ?? answer.text) : undefined;
  return (
    <DecisionCard
      id={seq}
      question={card.title}
      {...(card.note ? { detail: card.note } : {})}
      options={options}
      {...(card.recommended ? { recommended: card.recommended } : {})}
      {...(done ? { done } : {})}
      onAnswer={async (text) => {
        const picked = options.includes(text);
        sender.go(picked ? "pick" : "other", picked ? text : "Something else", picked ? { option: text } : { note: text });
        return true;
      }}
    />
  );
}

/** Pictures: two to four options as the pictures themselves, picked by a press or its letter; one is sent. */
function Pictures({ card, answer, sender }: CardProps) {
  const options = card.options ?? [];
  const done = answer ? String(answer.values.option ?? "") : null;
  const [sel, setSel] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");
  const pick = (label: string) => sender.go("pick", label, { option: label });
  const keys = (e: ReactKeyboardEvent) => {
    if (done || sender.sending || writing) return;
    const i = e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) - 65 : -1;
    if (i >= 0 && i < options.length) (e.preventDefault(), setSel(options[i]!.label));
    else if (e.key === "Enter" && sel) (e.preventDefault(), pick(sel));
  };
  const chosen = done ?? sender.sending ?? sel;
  return (
    <Shell
      card={card}
      className="gc-pictures"
      foot={
        done || sender.sending ? (
          <Sent text={done || sender.sending!} sending={!done} />
        ) : writing ? (
          <form
            className="gc-note-in"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim()) sender.go("other", "Something else", { note: note.trim() });
            }}
          >
            <PencilLineIcon className="gc-pen" aria-hidden="true" />
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What would you like instead?" aria-label="Something else" onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setWriting(false))} />
            <button type="submit" className="gc-send" disabled={!note.trim()} aria-label="Send">
              <ArrowUpIcon aria-hidden="true" />
            </button>
          </form>
        ) : (
          <Foot meta={`${options.map((_, i) => letter(i)).join(", ").replace(/, ([^,]*)$/, " or $1")} on the keyboard`}>
            <button type="button" className="gb ghost" onClick={() => setWriting(true)}>
              Something else
            </button>
            <button type="button" className="gb pri" disabled={!sel} onClick={() => sel && pick(sel)}>
              {sel ? `Use ${letter(options.findIndex((o) => o.label === sel))}` : "Pick one"}
            </button>
          </Foot>
        )
      }
    >
      <div className={cn("pc", (done || sender.sending) && "done")} role="radiogroup" aria-label={card.title} tabIndex={0} onKeyDown={keys} data-n={options.length}>
        {options.map((o, i) => {
          const src = o.image ? localPicture(o.image) : null;
          return (
            <button key={o.label} type="button" role="radio" aria-checked={chosen === o.label} className="pc-opt" disabled={!!done || !!sender.sending} onClick={() => setSel(o.label)} onDoubleClick={() => pick(o.label)}>
              <span className="pc-shot">
                {src ? <img src={src} alt="" loading="lazy" onLoad={(e) => (e.currentTarget.dataset.on = "")} /> : <span className="pc-missing">{o.image}</span>}
                {o.label === card.recommended && <span className="gc-rec">Recommended</span>}
              </span>
              <span className="pc-cap">
                <kbd aria-hidden="true">{letter(i)}</kbd>
                <span>
                  <b>{o.label}</b>
                  {o.detail && <small>{o.detail}</small>}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </Shell>
  );
}

/** A unified diff's lines, numbered as in the file: what was added by its new number, what was taken out by its old one. */
function diffLines(d: string): { kind: "hh" | "add" | "del" | "ctx"; n?: number; text: string }[] {
  const out: { kind: "hh" | "add" | "del" | "ctx"; n?: number; text: string }[] = [];
  let o = 0;
  let n = 0;
  for (const l of d.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push({ kind: "hh", text: l });
    } else if (l.startsWith("+")) out.push({ kind: "add", n: n++, text: l.slice(1) });
    else if (l.startsWith("-")) out.push({ kind: "del", n: o++, text: l.slice(1) });
    else if (l.startsWith(" ") || l === "") {
      if (!out.length) continue;
      out.push({ kind: "ctx", n: n, text: l.slice(1) });
      o++;
      n++;
    }
  }
  while (out.at(-1)?.kind === "ctx" && !out.at(-1)!.text) out.pop();
  return out;
}

/** A path as its folder, quiet, then its name. */
function PathText({ path }: { path: string }) {
  const at = path.lastIndexOf("/");
  return (
    <>
      {at >= 0 && <span>{path.slice(0, at + 1)}</span>}
      {path.slice(at + 1)}
    </>
  );
}

/** Changes: each file and what was added and taken out, unfolding in place; Open is Friday's own, the rest goes to the agent. */
function Changes({ card, lane, answer, sender }: CardProps) {
  const files = card.files ?? [];
  const [open, setOpen] = useState<string | null>(files.length === 1 ? files[0]!.path : null);
  const [undo, setUndo] = useState<string[]>([]);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const done = !!answer || !!sender.sending;
  const undone = answer ? ((v) => (Array.isArray(v) ? v : v ? [v] : []))(answer.values.undo) : undo;
  const openFile = (f: ChangedFile) => void window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: f.path, ...(lane !== MAIN_LANE ? { lane } : {}) }, cancelable: true }));
  const actions = card.actions ?? [];
  return (
    <Shell
      card={card}
      className="gc-changes"
      aside={
        <span className="ch-n">
          <span className="a">+{added}</span>
          <span className="d">−{removed}</span>
        </span>
      }
      foot={
        done ? (
          <Sent text={answer ? actions.find((a) => a.name === answer.action)?.label ?? answer.action : sender.sending!} sending={!answer} />
        ) : (
          <Actions
            actions={actions}
            meta={undo.length ? `${undo.length} to undo` : files.some((f) => f.diff) ? "Press a file to see what changed" : `${files.length} ${files.length === 1 ? "file" : "files"}`}
            onPress={(a, note) => sender.go(a.name, undo.length && a.primary ? `${a.label}, undoing ${undo.length}` : a.label, { ...(note ? { note } : {}), ...(undo.length ? { undo } : {}) })}
          />
        )
      }
    >
      <div className="ch-files">
        {files.map((f) => {
          const on = open === f.path;
          const lines = on && f.diff ? diffLines(f.diff) : [];
          const isUndone = undone.includes(f.path);
          return (
            <div key={f.path} className={cn("ch-file", on && "open", isUndone && "undone")}>
              <div className="ch-row">
                <button type="button" className="ch-toggle" aria-expanded={on} disabled={!f.diff} onClick={() => setOpen(on ? null : f.path)}>
                  <ChevronRightIcon className="ch-chev" aria-hidden="true" />
                  <FileIcon path={f.path} size={14} className="ch-ficon" />
                  <span className="ch-path">
                    <PathText path={f.path} />
                    {f.status !== "changed" && <em className={f.status}>{f.status}</em>}
                  </span>
                </button>
                <span className="ch-acts">
                  <button type="button" className="ch-act" onClick={() => openFile(f)} title={`Open it in the file view${ideHint()}`}>
                    <ArrowUpRightIcon aria-hidden="true" />
                    Open
                  </button>
                  {!done && (
                    <button type="button" className={cn("ch-act", isUndone && "on")} onClick={() => setUndo((u) => (u.includes(f.path) ? u.filter((x) => x !== f.path) : [...u, f.path]))} title={isUndone ? "Keep it" : "Ask for this file to be put back"}>
                      <Undo2Icon aria-hidden="true" />
                      {isUndone ? "Keep" : "Undo"}
                    </button>
                  )}
                </span>
                <span className="ch-n">
                  {f.added > 0 && <span className="a">+{f.added}</span>}
                  {f.removed > 0 && <span className="d">−{f.removed}</span>}
                </span>
              </div>
              {on && lines.length > 0 && (
                <div className="ch-diff" role="region" aria-label={`What changed in ${f.path}`}>
                  {lines.map((l, i) =>
                    l.kind === "hh" ? (
                      <div key={i} className="ch-hh">
                        {l.text}
                      </div>
                    ) : (
                      <div key={i} className={cn("ch-l", l.kind)}>
                        <i>{l.n}</i>
                        <b>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</b>
                        <span>{l.text}</span>
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

const SHELLS = new Set(["shell", "bash", "Bash", "run_command", "exec_command", "terminal"]);
const argsOf = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** The output of the command a run card names, once it has finished, from the agent's own step on that lane. */
function ranOutput(events: SessionEvent[], lane: string, from: number, command: string | undefined): string | null {
  const want = command?.trim().replace(/\s+/g, " ");
  if (!want) return null;
  const calls = new Set<string>();
  for (const e of events) {
    if (e.seq <= from || (e.lane ?? MAIN_LANE) !== lane) continue;
    if (e.body.type === "agent.message")
      for (const c of e.body.toolCalls) {
        const cmd = String(argsOf(c.arguments).command ?? argsOf(c.arguments).cmd ?? "").trim().replace(/\s+/g, " ");
        if (SHELLS.has(c.name) && cmd && (cmd === want || cmd.includes(want))) calls.add(c.id);
      }
    if (e.body.type === "tool.result" && calls.has(e.body.callId)) return e.body.output;
  }
  return null;
}

/** Seconds as a clock: 0:07, 1:24, 1:02:10. */
const clockOf = (ms: number) => ((t) => (t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`))(Math.max(0, Math.floor(ms / 1000)));

function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    // The page's one 1-second ticker, shared with every other clock and still while the window is hidden (presence.tsx).
    return tickEvery(1000, setNow);
  }, [on]);
  return now;
}

/** A run: numbers that move, failures as they land; done, what can be done about it. */
function Run({ card, lane, seq, events, answer, sender, updatedAt }: CardProps) {
  // Friday's own fill: the command's output once it finishes, read the way the steps read test output.
  const out = useMemo(() => ranOutput(events, lane, seq, card.command), [events, lane, seq, card.command]);
  const read = useMemo(() => (out ? testCounts(out) : null), [out]);
  const done = !!card.done || !!read;
  const passed = read?.passed ?? card.passed ?? 0;
  const failed = read?.failed ?? card.failed ?? 0;
  const skipped = read?.skipped ?? card.skipped ?? 0;
  const total = read?.total ?? card.total;
  const failures = card.failures?.length ? card.failures : (read?.failures ?? []);
  const now = useNow(!done);
  const started = card.startedAt ?? updatedAt;
  const took = (done ? updatedAt : now) - started;
  const ran = passed + failed + skipped;
  const pct = total ? Math.min(100, (ran / total) * 100) : done ? 100 : 0;
  const actions = card.actions?.length ? card.actions : failed > 0 ? [{ name: "fix", label: failed === 1 ? "Fix it" : `Fix ${failed === 2 ? "both" : "these"}`, primary: true }] : [];
  return (
    <Shell
      card={card}
      className={cn("gc-run", done && "is-done", failed > 0 && "has-fail")}
      aside={
        <span className={cn("lr-live", done && "off")}>
          <i aria-hidden="true" />
          {done ? `${failed ? "Finished" : "Passed"} in ${clockOf(took)}` : clockOf(took)}
        </span>
      }
      foot={
        answer || sender.sending ? (
          <Sent text={answer ? actions.find((a) => a.name === answer.action)?.label ?? answer.action : sender.sending!} sending={!answer} />
        ) : done && actions.length ? (
          <Actions actions={actions} onPress={(a, note) => sender.go(a.name, a.label, { ...(note ? { note } : {}), ...(failures.length ? { failures: failures.map((f) => f.name) } : {}) })} />
        ) : null
      }
    >
      {card.command && <p className="lr-cmd">{card.command}</p>}
      <div className="lr-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total ?? 100} aria-valuenow={total ? ran : Math.round(pct)} aria-label="How far it has got">
        <span className="fill" style={{ width: `${pct}%` }} />
        {total ? failures.slice(0, failed).map((_, i) => <span key={i} className="tickmark" style={{ left: `${Math.min(99, ((passed * (i + 1)) / Math.max(1, failed + 1) / total) * 100)}%` }} />) : null}
        {!done && !total && <span className="lr-sweep" />}
      </div>
      <div className="lr-nums">
        <div className="lr-num ok">
          <b>
            <Count n={passed} />
          </b>
          <span>passed</span>
        </div>
        <div className="lr-num bad">
          <b className={cn(failed > 0 && "has")}>
            <Count n={failed} />
          </b>
          <span>failed</span>
        </div>
        <div className="lr-num">
          <b>{done ? skipped : total ? Math.max(0, total - ran) : "–"}</b>
          <span>{done ? "skipped" : "to go"}</span>
        </div>
      </div>
      {failures.length > 0 && (
        <ul className="lr-fails">
          {failures.map((f) => (
            <li key={f.name} className="lr-fail">
              <i className="x" aria-hidden="true" />
              <b>{f.name}</b>
              {f.where ? <small>{f.where}</small> : <span />}
              {f.detail && <p>{f.detail}</p>}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

/** A cell that is a number lines up on the right, as in a spreadsheet. */
const numeric = (v: string) => /^[-+]?[\d.,]+\s?(%|ms|s|KB|MB|GB|x|×)?$/.test(v.trim());
const sortKey = (v: string) => (numeric(v) ? Number(v.replace(/[^\d.-]/g, "")) : v.toLowerCase());

/** Select: rows to tick, sorted by a column; the button counts what's ticked. */
function Select({ card, answer, sender }: CardProps) {
  const cols = card.columns ?? [];
  const items = card.items ?? [];
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(items.filter((x) => x.checked).map((x) => x.id)));
  const [sort, setSort] = useState<{ col: number; up: boolean } | null>(null);
  const done = answer || sender.sending;
  const final = answer ? new Set(((v) => (Array.isArray(v) ? v : v ? [v] : []))(answer.values.items).map(String)) : ticked;
  const right = cols.map((_, i) => items.length > 0 && items.every((r) => !r.cells[i] || numeric(r.cells[i]!)));
  const rows = useMemo(() => (sort ? [...items].sort((a, b) => ((x, y) => (x < y ? -1 : x > y ? 1 : 0))(sortKey(a.cells[sort.col] ?? ""), sortKey(b.cells[sort.col] ?? "")) * (sort.up ? 1 : -1)) : items), [items, sort]);
  const trend = items.some((x) => x.trend?.length);
  const toggle = (id: string) => !done && setTicked((t) => ((n) => (n.has(id) ? n.delete(id) : n.add(id), n))(new Set(t)));
  const all = ticked.size === items.length;
  const primary: UiAction = card.actions?.find((a) => a.primary) ?? { name: "take", label: card.submit || "Use {n}", primary: true };
  const others = card.actions?.filter((a) => a !== primary) ?? [{ name: "skip", label: "Not now" }];
  const label = (a: UiAction) => (a === primary ? a.label.replace("{n}", String(ticked.size)) : a.label);
  const picked = items.filter((x) => ticked.has(x.id));
  return (
    <Shell
      card={card}
      className="gc-select"
      foot={
        done ? (
          <Sent text={answer ? `${label(card.actions?.find((a) => a.name === answer.action) ?? (answer.action === primary.name ? primary : { name: answer.action, label: answer.action })).replace(/\{n\}/, String(final.size))}` : sender.sending!} sending={!answer} />
        ) : (
          <Actions
            actions={[...others, primary]}
            meta={`${ticked.size} ticked`}
            disabled={(a) => a === primary && !ticked.size}
            primaryLabel={label}
            onPress={(a, note) => sender.go(a.name, label(a), { items: a === primary ? picked.map((x) => x.id) : [], ...(note ? { note } : {}) }, a === primary ? picked.map((x) => `  • ${x.cells[0]}`) : [])}
          />
        )
      }
    >
      <div className="st-wrap">
        <table className={cn("st", done && "done")}>
          <thead>
            <tr>
              <th className="c0" scope="col">
                <button type="button" className={cn("cbx", all ? "on" : ticked.size ? "some" : "")} aria-label={all ? "Untick all" : "Tick all"} disabled={!!done} onClick={() => setTicked(all ? new Set() : new Set(items.map((x) => x.id)))}>
                  <CheckIcon aria-hidden="true" />
                </button>
              </th>
              {cols.map((c, i) => (
                <th key={i} scope="col" className={cn(right[i] && "num")} aria-sort={sort?.col === i ? (sort.up ? "ascending" : "descending") : undefined}>
                  <button type="button" data-on={sort?.col === i ? (sort.up ? "up" : "down") : undefined} onClick={() => setSort((s) => (s?.col === i ? (s.up ? { col: i, up: false } : null) : { col: i, up: !right[i] }))}>
                    {c}
                    <ArrowDownIcon aria-hidden="true" />
                  </button>
                </th>
              )).flatMap((th, i) => (i === 0 && trend ? [th, <th key="trend" scope="col">{card.trendLabel ?? ""}</th>] : [th]))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const on = final.has(r.id);
              return (
                <tr key={r.id} className={cn(on && "on")} onClick={() => toggle(r.id)} aria-selected={on}>
                  <td className="c0">
                    <span className={cn("cbx", on && "on")} role="checkbox" aria-checked={on} aria-label={r.cells[0]} tabIndex={done ? -1 : 0} onKeyDown={(e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle(r.id))}>
                      <CheckIcon aria-hidden="true" />
                    </span>
                  </td>
                  {cols
                    .map((_, j) => (
                      <td key={j} className={cn(j === 0 && "name", right[j] && "num")}>
                        {j === 0 ? <NameCell v={r.cells[0] ?? ""} /> : r.cells[j]}
                      </td>
                    ))
                    .flatMap((td, j) =>
                      j === 0 && trend
                        ? [
                            td,
                            <td key="trend">
                              <span className="strip" aria-hidden="true">
                                {(r.trend ?? []).map((v, k) => (
                                  <i key={k} className={cn(v > 0 && "f")} />
                                ))}
                              </span>
                            </td>,
                          ]
                        : [td],
                    )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

/** A row's name: what comes before a › quiet, the rest plain ("checkout › retries a soft decline"). */
function NameCell({ v }: { v: string }) {
  const at = v.lastIndexOf(" › ");
  return at < 0 ? <>{v}</> : (
    <>
      <span>{v.slice(0, at + 3)}</span>
      {v.slice(at + 3)}
    </>
  );
}

/** A field's starting value. */
const startOf = (f: FormField) => f.value ?? (f.type === "toggle" ? "no" : f.type === "select" ? (f.options?.[0] ?? "") : "");

/** One field: a switch of segments for two or three choices, a picker for more, a switch for yes and no, else a box checked as it's typed. */
function FieldInput({ f, value, onChange, problem, touched, disabled }: { f: FormField; value: string; onChange: (v: string) => void; problem: string; touched: boolean; disabled?: boolean }) {
  if (f.type === "toggle") return <Switch checked={value === "yes"} onCheckedChange={(on) => onChange(on ? "yes" : "no")} aria-label={f.label} disabled={!!disabled} />;
  if (f.type === "select" && (f.options?.length ?? 0) <= 3)
    return (
      <span className="mseg" role="radiogroup" aria-label={f.label}>
        {f.options!.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={value === o} disabled={!!disabled} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </span>
    );
  if (f.type === "select") return <Picker className="gu-select" value={value} label={f.label} onChange={onChange} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />;
  const bad = touched && !!problem;
  const good = !problem && !!value.trim() && (!!f.pattern || f.min !== undefined || f.max !== undefined || !!f.required);
  return (
    <span className={cn("fld", bad && "bad", good && "good")}>
      <span className="fld-box">
        <input type={f.type === "number" ? "number" : "text"} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} aria-invalid={bad} aria-label={f.label} disabled={!!disabled} spellCheck={false} />
        <CheckIcon className="fld-ok" aria-hidden="true" />
      </span>
      {(bad || f.hint) && <span className="fld-msg">{bad ? problem : f.hint}</span>}
    </span>
  );
}

/** Go-ahead: exactly what will run, the person's settings put into it as they set them; Approve stays off until every check passes. */
function GoAhead({ card, answer, sender }: CardProps) {
  const fields = card.fields ?? [];
  const sent = answer?.values ?? null;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, startOf(f)])));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const shown = sent ? Object.fromEntries(fields.map((f) => [f.id, String(sent[f.id] ?? values[f.id] ?? "")])) : values;
  const problems = Object.fromEntries(fields.map((f) => [f.id, fieldProblem(f, shown[f.id] ?? "")]));
  const ok = fields.every((f) => !problems[f.id]);
  const done = !!answer || !!sender.sending;
  const checked = fields.filter((f) => f.pattern || f.required || f.min !== undefined || f.max !== undefined);
  return (
    <Shell
      card={card}
      className="gc-goahead"
      tag={
        <span className="ga-tag">
          <ShieldCheckIcon aria-hidden="true" />
          Go-ahead
        </span>
      }
      foot={
        done ? (
          <Sent text={answer ? (answer.action === "approve" ? `Approved${fields.length ? `: ${fields.filter((f) => f.type !== "toggle").map((f) => shown[f.id]).filter(Boolean).join(", ")}` : ""}` : answer.action === "hold" ? "Held" : answer.action) : sender.sending!} sending={!answer} />
        ) : (
          <Actions
            actions={[
              { name: "hold", label: "Hold", input: "Why hold it? (optional, Enter to send)" },
              { name: "approve", label: card.approve || "Approve", primary: true },
            ]}
            meta={checked.length ? `Friday checks ${checked.length === 1 ? `the ${checked[0]!.label.toLowerCase()}` : "these"} as you type` : "Nothing runs until you approve"}
            disabled={(a) => a.name === "approve" && !ok}
            onPress={(a, note) => (a.name === "approve" ? sender.go("approve", a.label, values, ["Run:", ...filled(card.commands ?? [], values).map((c) => `  $ ${c}`)]) : sender.go("hold", "Hold", note ? { note } : {}))}
          />
        )
      }
    >
      <p className="ga-label">What will run</p>
      <div className="ga-runs">
        {(card.commands ?? []).map((c, i) => (
          <div key={i}>
            {c.split(/(\{[\w-]+\})/).map((part, j) => {
              const k = /^\{([\w-]+)\}$/.exec(part)?.[1];
              return k && k in shown ? (
                <span key={`${j}-${shown[k]}`} className={cn("var", !shown[k] && "empty")}>
                  {shown[k] || (fields.find((f) => f.id === k)?.label.toLowerCase() ?? k)}
                </span>
              ) : (
                <span key={j}>{part}</span>
              );
            })}
          </div>
        ))}
      </div>
      {fields.length > 0 && (
        <div className="ga-fields">
          {fields.map((f) => (
            <div key={f.id} className="ga-f">
              <span className="lab">
                {f.label}
                {f.placeholder && f.type === "toggle" && <small>{f.placeholder}</small>}
              </span>
              <FieldInput f={f} value={shown[f.id] ?? ""} problem={problems[f.id] ?? ""} touched={touched.has(f.id) || !!(shown[f.id] ?? "").trim()} disabled={done} onChange={(v) => (setValues((x) => ({ ...x, [f.id]: v })), setTouched((t) => new Set(t).add(f.id)))} />
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

/** A few values the agent needs: checked as they're typed, sent together; once sent, what was. */
function Form({ card, answer, sender }: CardProps) {
  const fields = card.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, startOf(f)])));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  if (answer) {
    // Older answers said their values as lines ("- Label: value"); newer ones carry them.
    const said = Object.keys(answer.values).length ? Object.fromEntries(fields.map((f) => [f.label, String(answer.values[f.id] ?? "")])) : Object.fromEntries(answer.text.split("\n").flatMap((l) => ((m) => (m ? [[m[1]!, m[2]!]] : []))(/^- (.+?): (.*)$/.exec(l))));
    return (
      <Shell card={card} foot={<Sent text="Sent" />}>
        <dl className="gu-answers">
          {fields.map((f) => (
            <div key={f.id}>
              <dt>{f.label}</dt>
              <dd className={cn(!said[f.label] || said[f.label] === "(left empty)" ? "muted" : "")}>{said[f.label] || "—"}</dd>
            </div>
          ))}
        </dl>
      </Shell>
    );
  }
  const problems = Object.fromEntries(fields.map((f) => [f.id, fieldProblem(f, values[f.id] ?? "")]));
  const ok = fields.every((f) => !problems[f.id]);
  return (
    <Shell card={card} foot={sender.sending ? <Sent text={sender.sending} sending /> : <Actions actions={[{ name: "send", label: card.submit || "Send", primary: true }]} disabled={() => !ok} onPress={(a) => sender.go("send", a.label, values)} />}>
      <div className="ga-fields gu-form">
        {fields.map((f) => (
          <div key={f.id} className="ga-f">
            <span className="lab">{f.label}</span>
            <FieldInput f={f} value={values[f.id] ?? ""} problem={problems[f.id] ?? ""} touched={touched.has(f.id)} onChange={(v) => (setValues((x) => ({ ...x, [f.id]: v })), setTouched((t) => new Set(t).add(f.id)))} />
          </div>
        ))}
      </div>
    </Shell>
  );
}

function Table({ card }: { card: UiCard }) {
  const cols = card.columns ?? [];
  const rows = card.rows ?? [];
  const right = cols.map((_, i) => rows.length > 0 && rows.every((r) => !r[i] || numeric(r[i]!)));
  return (
    <div className="gu-table-wrap">
      <table className="gu-table">
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className={cn(right[i] && "num")} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((_, j) => (
                <td key={j} className={cn(right[j] && "num")}>
                  {r[j]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Up to four series, at the width of the card: bars side by side per label, or lines. */
// The room's accent first, then a quiet grey: --violet is near white in the dark theme, and a second accent shouted.
const SERIES = ["var(--agent)", "color-mix(in srgb, var(--ink) 34%, transparent)", "var(--amber)", "color-mix(in srgb, var(--agent) 45%, transparent)"];
const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(+n.toFixed(2)));

function Chart({ card }: { card: UiCard }) {
  const labels = card.labels ?? [];
  const series = card.series ?? [];
  const all = series.flatMap((s) => s.values);
  const top = Math.max(0, ...all);
  const bottom = Math.min(0, ...all);
  const span = top - bottom || 1;
  const W = 560;
  const H = 180;
  const pad = { l: 8, r: 8, t: 18, b: 22 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ((top - v) / span) * ih;
  const slot = iw / labels.length;
  const unit = card.unit ? ` ${card.unit}` : "";
  return (
    <figure className="gu-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${card.title}: ${series.map((s) => `${s.name} ${s.values.map((v, i) => `${labels[i]} ${fmt(v)}${unit}`).join(", ")}`).join("; ")}`}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="gu-axis" />
        {card.chart === "line"
          ? series.map((s, k) => {
              const pts = s.values.map((v, i) => [pad.l + slot * i + slot / 2, y(v)] as const);
              return (
                <g key={k} style={{ "--c": SERIES[k] } as React.CSSProperties}>
                  <polyline points={pts.map((p) => p.join(",")).join(" ")} className="gu-line" />
                  {pts.map(([px, py], i) => (
                    <circle key={i} cx={px} cy={py} r={3} className="gu-dot">
                      <title>{`${s.name}, ${labels[i]}: ${fmt(s.values[i]!)}${unit}`}</title>
                    </circle>
                  ))}
                </g>
              );
            })
          : labels.map((_, i) => {
              const bw = Math.min(36, (slot * 0.7) / series.length);
              const x0 = pad.l + slot * i + (slot - bw * series.length) / 2;
              return series.map((s, k) => {
                const v = s.values[i]!;
                return (
                  <rect key={`${i}-${k}`} x={x0 + bw * k} width={Math.max(1, bw - 2)} y={Math.min(y(v), y(0))} height={Math.max(1, Math.abs(y(v) - y(0)))} rx={3} className="gu-bar" style={{ "--c": SERIES[k] } as React.CSSProperties}>
                    <title>{`${s.name}, ${labels[i]}: ${fmt(v)}${unit}`}</title>
                  </rect>
                );
              });
            })}
        {series.length === 1 &&
          card.chart !== "line" &&
          series[0]!.values.map((v, i) => (
            <text key={i} x={pad.l + slot * i + slot / 2} y={Math.min(y(v), y(0)) - 5} className="gu-value" textAnchor="middle">
              {fmt(v)}
            </text>
          ))}
        {labels.map((l, i) => (
          <text key={i} x={pad.l + slot * i + slot / 2} y={H - 6} className="gu-label" textAnchor="middle">
            {l}
          </text>
        ))}
      </svg>
      {(series.length > 1 || card.unit) && (
        <figcaption className="gu-legend">
          {series.length > 1 &&
            series.map((s, k) => (
              <span key={k} style={{ "--c": SERIES[k] } as React.CSSProperties}>
                <i aria-hidden="true" />
                {s.name}
              </span>
            ))}
          {card.unit && <span className="gu-unit">In {card.unit}</span>}
        </figcaption>
      )}
    </figure>
  );
}

/** Two things side by side: pictures as the session serves them (only from its folders or named in its log), or texts. */
function Compare({ card }: { card: UiCard }) {
  const side = (x: CompareSide | undefined, which: string) => {
    if (!x) return null;
    const src = x.image ? localPicture(x.image) : null;
    return (
      <figure className="gu-side" aria-label={x.label || which}>
        <figcaption>{x.label}</figcaption>
        {src ? <img src={src} alt={x.label} loading="lazy" /> : x.image ? <p className="gu-side-missing">{x.image}</p> : null}
        {x.text && <pre className={cn("gu-side-text", card.code && "code")}>{x.text}</pre>}
      </figure>
    );
  };
  return (
    <div className="gu-compare">
      {side(card.left, "Before")}
      {side(card.right, "After")}
    </div>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** The pages an agent read: each opens in the browser, its site's own icon beside it, and why it matters under it. */
function Sources({ card, sid, invite }: { card: UiCard; sid: string; invite: string }) {
  return (
    <ul className="gu-sources">
      {(card.links ?? []).map((l, i) => (
        <li key={i}>
          <a href={l.url} target="_blank" rel="noopener noreferrer">
            <SiteIcon host={hostOf(l.url)} sid={sid} invite={invite} />
            <span className="gu-source-text">
              <span className="gu-source-title">
                {l.title}
                <ArrowUpRightIcon className="size-3" />
              </span>
              <span className="gu-source-host">{hostOf(l.url)}</span>
              {l.note && <span className="gu-source-note">{l.note}</span>}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A number that counts to where it is now, rather than jumping (a run's passes, a stat). */
function Count({ n }: { n: number }) {
  const [shown, setShown] = useState(n);
  const from = useRef(n);
  useEffect(() => {
    const a = from.current;
    if (a === n || typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return void ((from.current = n), setShown(n));
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 450);
      const v = Math.round(a + (n - a) * (1 - Math.pow(1 - k, 3)));
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = n;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = n;
    };
  }, [n]);
  return <>{shown.toLocaleString()}</>;
}

/** A value that is a number counts; anything else ("1.2s", "$4.1k") as it is, its number counting inside it. */
function Value({ v }: { v: string }) {
  const m = /^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/.exec(v);
  if (!m || m[2]!.includes(".")) return <>{v}</>;
  return (
    <>
      {m[1]}
      <Count n={Number(m[2]!.replace(/,/g, ""))} />
      {m[3]}
    </>
  );
}

/** A delta's tone: up is good unless less is better, as the tile says. */
const deltaTone = (t: StatTile): Tone => {
  const d = t.delta?.trim() ?? "";
  if (!d || /^[±0]/.test(d)) return "neutral";
  const up = !/^[-−–↓]/.test(d);
  return !t.better ? "neutral" : up === (t.better === "up") ? "good" : "bad";
};

/** A short history as a line, its last point marked. */
function Spark({ values, tone }: { values: number[]; tone: Tone }) {
  const W = 100;
  const H = 28;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * W, H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6)] as const);
  const line = pts.map((p) => p.join(",")).join(" ");
  const last = pts.at(-1)!;
  return (
    <svg className="st-spark" data-tone={tone} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,${H} ${line} ${W},${H}`} className="st-area" />
      <polyline points={line} className="st-line" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="2.2" className="st-end" />
    </svg>
  );
}

/** Stats: a few numbers worth a glance, each with how it moved and its recent history. */
function Stats({ card }: CardProps) {
  const tiles = card.tiles ?? [];
  return (
    <Shell card={card} className="gc-stats">
      <div className="st-tiles" data-n={tiles.length}>
        {tiles.map((t) => {
          const tone = deltaTone(t);
          const Trend = /^[-−–↓]/.test(t.delta ?? "") ? TrendingDownIcon : TrendingUpIcon;
          return (
            <div key={t.label} className="st-tile">
              <span className="st-label">{t.label}</span>
              <span className="st-value">
                <Value v={t.value} />
              </span>
              <span className="st-meta">
                {t.delta && (
                  <span className="st-delta" data-tone={tone}>
                    <Trend aria-hidden="true" />
                    {t.delta}
                  </span>
                )}
                {t.note && <span className="st-note">{t.note}</span>}
              </span>
              {t.spark && <Spark values={t.spark} tone={tone} />}
            </div>
          );
        })}
      </div>
    </Shell>
  );
}

/** Draft: something written for somewhere, as it will read there; edited in place, then Looks good or Ask for changes. */
function Draft({ card, answer, sender }: CardProps) {
  const on = DRAFT_ON[card.channel ?? "post"];
  const [text, setText] = useState(card.body ?? "");
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const edited = text.trim() !== (card.body ?? "").trim();
  const sent = answer?.values.text ? String(answer.values.text) : null;
  const shown = sent ?? text;
  const over = card.limit ? shown.length > card.limit : false;
  const done = !!answer || !!sender.sending;
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing || !field.current) return;
    field.current.focus();
    field.current.style.height = "auto";
    field.current.style.height = `${field.current.scrollHeight}px`;
  }, [editing, text]);
  const actions = (card.actions ?? []).map((a) => (a.primary && edited ? { ...a, label: "Use my edit" } : a));
  return (
    <Shell
      card={card}
      className={cn("gc-draft", `on-${card.channel ?? "post"}`)}
      aside={
        <span className="df-on">
          {on.word}
          {card.limit ? <span className={cn("df-count", over && "over")}>{`${shown.length}/${card.limit}`}</span> : null}
        </span>
      }
      foot={
        done ? (
          <Sent text={answer ? ((card.actions ?? []).find((a) => a.name === answer.action)?.label ?? answer.action) + (sent ? " · your edit" : "") : sender.sending!} sending={!answer} />
        ) : (
          <Actions
            actions={actions}
            meta={
              <button type="button" className="df-tool" onClick={() => void navigator.clipboard?.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))}>
                {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                {copied ? "Copied" : "Copy"}
              </button>
            }
            disabled={(a) => !!a.primary && over}
            onPress={(a, note) => sender.go(a.name, a.primary && edited ? "Use my edit" : a.label, { ...(note ? { note } : {}), ...(a.primary && edited ? { text } : {}) }, a.primary && edited ? ["", text] : [])}
          />
        )
      }
    >
      <div className="df-frame">
        {(card.to || card.subject) && (
          <dl className="df-meta">
            {card.to && (
              <div>
                <dt>To</dt>
                <dd>{card.to}</dd>
              </div>
            )}
            {card.subject && (
              <div>
                <dt>Subject</dt>
                <dd className="df-subject">{card.subject}</dd>
              </div>
            )}
          </dl>
        )}
        {editing && !done ? (
          <textarea ref={field} className="df-body df-edit" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(false))} aria-label="The draft" spellCheck />
        ) : (
          <button type="button" className="df-body" disabled={done} onClick={() => setEditing(true)} title={done ? undefined : "Press to edit"}>
            {shown}
            {!done && <span className="df-hint">{edited ? "Edited" : "Press to edit"}</span>}
          </button>
        )}
      </div>
    </Shell>
  );
}

/** Slots: times to pick from, by day; one is sent. */
function Slots({ card, answer, sender }: CardProps) {
  const days = card.days ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const done = answer ? String(answer.values.slot ?? "") : sender.sending;
  const chosen = done ?? sel;
  return (
    <Shell
      card={card}
      className="gc-slots"
      aside={card.length || card.zone ? <span>{[card.length, card.zone].filter(Boolean).join(" · ")}</span> : null}
      foot={
        done ? (
          <Sent text={done} sending={!answer} />
        ) : (
          <Foot meta={sel ? sel : "Pick a time"}>
            <button type="button" className="gb pri" disabled={!sel} onClick={() => sel && sender.go("pick", sel, { slot: sel })}>
              {sel ? "Use this time" : "Pick one"}
            </button>
          </Foot>
        )
      }
    >
      <div className="sl-days" role="radiogroup" aria-label={card.title}>
        {days.map((d) => (
          <div key={d.label} className="sl-day">
            <span className="sl-label">{d.label}</span>
            {d.times.map((t) => {
              const v = `${d.label} · ${t}`;
              return (
                <button key={t} type="button" role="radio" aria-checked={chosen === v} className="sl-time" disabled={!!done} onClick={() => setSel(v)}>
                  {t}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Matrix: options weighed criterion by criterion; a column is picked by its head or any of its cells. */
function Matrix({ card, answer, sender }: CardProps) {
  const choices = card.choices ?? [];
  const rows = card.criteria ?? [];
  const [sel, setSel] = useState<string | null>(null);
  const done = answer ? String(answer.values.option ?? "") : sender.sending;
  const chosen = done ?? sel;
  const goods = choices.map((_, i) => rows.filter((r) => r.cells[i]?.tone === "good").length);
  return (
    <Shell
      card={card}
      className="gc-matrix"
      foot={
        done ? (
          <Sent text={done} sending={!answer} />
        ) : (
          <Foot meta={sel ? `${goods[choices.indexOf(sel)]} of ${rows.length} in its favour` : "Press a column to pick it"}>
            <button type="button" className="gb pri" disabled={!sel} onClick={() => sel && sender.go("pick", sel, { option: sel })}>
              {sel ? `Go with ${sel}` : "Pick one"}
            </button>
          </Foot>
        )
      }
    >
      <div className="mx-wrap">
        <table className={cn("mx", done && "done")} style={{ "--cols": choices.length } as React.CSSProperties}>
          <thead>
            <tr>
              <th scope="col" />
              {choices.map((c) => (
                <th key={c} scope="col" className={cn(chosen === c && "on")}>
                  <button type="button" disabled={!!done} onClick={() => setSel(c)} aria-pressed={chosen === c}>
                    <span>{c}</span>
                    {c === card.recommended && <span className="gc-rec">Recommended</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                {choices.map((c, i) => (
                  <td key={c} className={cn(chosen === c && "on")} data-tone={r.cells[i]?.tone} onClick={() => !done && setSel(c)}>
                    {r.cells[i]?.tone && <i aria-hidden="true" />}
                    {r.cells[i]?.text}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="mx-score">
              <th scope="row">In its favour</th>
              {choices.map((c, i) => (
                <td key={c} className={cn(chosen === c && "on")} onClick={() => !done && setSel(c)}>
                  <span className="mx-bar">
                    <span style={{ width: `${rows.length ? (goods[i]! / rows.length) * 100 : 0}%` }} />
                  </span>
                  {goods[i]}/{rows.length}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

const LINK_ICON: Record<NonNullable<LinkItem["kind"]>, Mark> = { page: GlobeIcon, doc: FileTextIcon, pr: GitPullRequestIcon, issue: CircleDotIcon, video: VideoIcon, repo: FileCodeIcon, file: FileTextIcon };

/** Links: pages, documents, pull requests or videos, each a card with what it is and where it stands; they open in the browser. */
function Links({ card, sid, invite }: CardProps) {
  const links = card.links ?? [];
  return (
    <Shell card={card} className="gc-links">
      <div className="lk-grid" data-n={links.length}>
        {links.map((l) => {
          const Icon = LINK_ICON[l.kind ?? "page"];
          const host = hostOf(l.url);
          return (
            <a key={l.url} className="lk" href={l.url} target="_blank" rel="noopener noreferrer">
              <span className="lk-mark" data-kind={l.kind ?? "page"}>
                {l.kind && l.kind !== "page" ? <Icon aria-hidden="true" /> : <SiteIcon host={host} sid={sid} invite={invite} />}
              </span>
              <span className="lk-text">
                <span className="lk-title">{l.title}</span>
                <span className="lk-where">
                  {host}
                  {l.meta && <span className="lk-meta" data-meta={l.meta.toLowerCase()}>{l.meta}</span>}
                </span>
                {l.note && <span className="lk-note">{l.note}</span>}
              </span>
              <ArrowUpRightIcon className="lk-go" aria-hidden="true" />
            </a>
          );
        })}
      </div>
    </Shell>
  );
}

/** File: a few lines of a file, numbered, the ones that matter marked; Open is Friday's own. */
function FileCard({ card, lane }: CardProps) {
  const lines = (card.body ?? "").split("\n");
  const start = card.start ?? 1;
  const marked = new Set(card.marked ?? []);
  const [copied, setCopied] = useState(false);
  const open = () => card.path && window.dispatchEvent(new CustomEvent("friday:open-file", { detail: { path: card.path, line: card.marked?.[0] ?? start, ...(lane !== MAIN_LANE ? { lane } : {}) }, cancelable: true }));
  return (
    <Shell
      card={card}
      className="gc-file"
      aside={
        <span className="fc-tools">
          <button type="button" className="ch-act" onClick={() => void navigator.clipboard?.writeText(card.body ?? "").then(() => (setCopied(true), setTimeout(() => setCopied(false), 1400)))}>
            {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
          {card.path && (
            <button type="button" className="ch-act" onClick={open} title={`Open it in the file view${ideHint()}`}>
              <ArrowUpRightIcon aria-hidden="true" />
              Open
            </button>
          )}
        </span>
      }
    >
      {card.path && (
        <div className="fc-path">
          <FileIcon path={card.path} size={14} />
          <span>
            <PathText path={card.path} />
          </span>
          {card.language && <em>{card.language}</em>}
        </div>
      )}
      <div className="fc-code" role="region" aria-label={card.path ?? card.title}>
        {lines.map((l, i) => (
          <div key={i} className={cn("fc-l", marked.has(start + i) && "on")}>
            <i>{start + i}</i>
            <span>{l || " "}</span>
          </div>
        ))}
      </div>
    </Shell>
  );
}

/** Timeline: what happened, or what will, in order, on a thin rail. */
function Timeline({ card }: CardProps) {
  const events = card.events ?? [];
  return (
    <Shell card={card} className="gc-timeline">
      <ol className="tl">
        {events.map((e, i) => (
          <li key={`${i}-${e.title}`} className="tl-e" data-tone={e.tone ?? "neutral"}>
            <span className="tl-dot" aria-hidden="true" />
            <span className="tl-when">{e.when}</span>
            <div className="tl-body">
              <span className="tl-title">
                {e.title}
                {e.tag && <span className="tl-tag">{e.tag}</span>}
              </span>
              {e.detail && <span className="tl-detail">{e.detail}</span>}
            </div>
          </li>
        ))}
      </ol>
    </Shell>
  );
}

/** A card that can't be drawn is one quiet line in the reply, not the whole session (guard.tsx). */
export function GenCard(props: Parameters<typeof GenCardDrawn>[0]) {
  return (
    <Guard where="card" reset={props.ev.seq} fallback={(c) => <GuardLine caught={c} label="This card couldn't be shown" />}>
      <GenCardDrawn {...props} />
    </Guard>
  );
}
