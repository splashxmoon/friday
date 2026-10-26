import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeftIcon, ArrowRightIcon, BugIcon, CheckIcon, ClockIcon, CopyIcon, FolderOpenIcon, GitPullRequestIcon, InboxIcon, PlayIcon, PlusIcon, ScrollTextIcon, Trash2Icon, WebhookIcon, WrenchIcon, ZapIcon, type LucideIcon } from "lucide-react";
import type { AgentSchedule, AgentView } from "../agents.js";
import type { Automation, AutomationRun } from "../automations.js";
import { ENGINE_NAMES, type EngineMode, type EngineTool } from "../types.js";
import { api } from "./api.js";
import { isLocal } from "./edition.js";
import { EngineMark, FridayMark } from "./BrandMarks.js";
import { useMachine } from "./local.js";
import type { Identity, RecentSession } from "./storage.js";
import { TaskMark, type TaskMarkState } from "./TaskMark.js";
import { relTime, useConfirm } from "./ui.js";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/dass";
import { PageTabs, Tip } from "@/components/dass/page-bits";

/**
 * Automations (Arun, 2026-10-23: "get rid of the agents tab page and replace it with automations, this will for the coding
 * tools and stuff in sessions we need to make this very advanced but very easy to understand and use").
 *
 * Each one reads as a sentence: when something happens, who does it (a coding tool, a team led by one, or Friday with a
 * saved agent), where, what it is told, and what then. Templates start the common ones in a press; every run is a session of
 * its own, listed under the automation with the way into it. The server keeps and runs them (automations.ts).
 */

type View = Omit<Automation, "when"> & {
  when: Automation["when"] | { kind: "webhook"; url?: string };
  says: { when: string; who: string };
  mine: boolean;
  runs: AutomationRun[];
  today: number;
};
type Draft = {
  name: string;
  on: boolean;
  when: { kind: "schedule"; schedule: AgentSchedule } | { kind: "webhook"; url?: string } | { kind: "session"; sessionId: string; sessionTitle: string; on: "finished" | "failed" } | { kind: "manual" };
  who: { tool: EngineTool | "friday"; team: EngineTool[]; mode: EngineMode; model: string; agentId: string };
  folder: string;
  copy: boolean;
  does: string;
  then: { pr: boolean; notify: boolean };
  limits: { perDay: number; offline: "wait" | "skip" };
};

const TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS = [1, 2, 3, 4, 5];

const blank = (): Draft => ({
  name: "",
  on: true,
  when: { kind: "manual" },
  who: { tool: "claude", team: [], mode: "full", model: "", agentId: "" },
  folder: "",
  copy: true,
  does: "",
  then: { pr: false, notify: true },
  limits: { perDay: 10, offline: "wait" },
});

/** The common ones, a press away. Each is a draft to look over, not something that runs before it is saved. */
/** `tone`: a state colour from style.css (--st-*), so each template is told apart at a glance. */
const TEMPLATES: { id: string; title: string; blurb: string; icon: LucideIcon; tone: string; make: () => Partial<Draft> }[] = [
  {
    id: "ci",
    icon: WrenchIcon,
    tone: "--st-blocked",
    title: "Fix failing CI",
    blurb: "Your CI calls its webhook when a build fails; a coding tool finds why and opens a fix.",
    make: () => ({ name: "Fix failing CI", when: { kind: "webhook" }, does: "A CI build failed. Find out why and fix it, then run the tests again.\n\nWhat the CI sent:\n{{event}}", then: { pr: true, notify: true } }),
  },
  {
    id: "review",
    icon: GitPullRequestIcon,
    tone: "--st-review",
    title: "Review every PR",
    blurb: "Called for each new pull request: reads the change, runs the tests, says what must change.",
    make: () => ({ name: "Review every PR", when: { kind: "webhook" }, does: "Review this pull request: read the change against what it says it does, run the tests, and give a short review with anything that must change before it merges.\n\n{{event}}", then: { pr: false, notify: true } }),
  },
  {
    id: "sweep",
    icon: BugIcon,
    tone: "--st-queued",
    title: "Morning bug sweep",
    blurb: "Every weekday at 9: goes through the open bugs, fixes the safe ones, lists the rest.",
    make: () => ({ name: "Morning bug sweep", when: { kind: "schedule", schedule: { every: "weekly", at: "09:00", days: WEEKDAYS, tz: TZ } }, does: "Look through the open bugs and yesterday's errors. Fix the ones you can fix safely and list the rest with where each one lives in the code.", then: { pr: true, notify: true } }),
  },
  {
    id: "triage",
    icon: InboxIcon,
    tone: "--st-working",
    title: "Triage new issues",
    blurb: "Called when an issue is filed: finds where it lives in the code and how big the fix is.",
    make: () => ({ name: "Triage new issues", when: { kind: "webhook" }, who: { tool: "claude", team: [], mode: "plan", model: "", agentId: "" }, does: "A new issue came in. Find where in the code it lives, say how big the fix is and who should look at it. Don't change anything.\n\n{{event}}", then: { pr: false, notify: true } }),
  },
  {
    id: "changelog",
    icon: ScrollTextIcon,
    tone: "--st-done",
    title: "Weekly changelog",
    blurb: "Fridays at 4: writes up what merged this week, in plain words, grouped by area.",
    make: () => ({ name: "Weekly changelog", when: { kind: "schedule", schedule: { every: "weekly", at: "16:00", days: [5], tz: TZ } }, does: "Write a changelog of what merged this week, grouped by area, in plain words a customer would understand.", then: { pr: false, notify: true } }),
  },
];

/**
 * On your own computer: no starter that waits for GitHub to call it, since its webhook is this computer's own address, which
 * GitHub can't reach. Two more that run on a clock instead, so the shelf is as full.
 */
const LOCAL_TEMPLATES: typeof TEMPLATES = [
  {
    id: "nightly-tests",
    icon: CheckIcon,
    tone: "--st-review",
    title: "Nightly tests",
    blurb: "Every night at 2: runs the tests, fixes what fails, and opens a pull request with the fix.",
    make: () => ({ name: "Nightly tests", when: { kind: "schedule", schedule: { every: "daily", at: "02:00", days: [], tz: TZ } }, does: "Run the project's tests. If anything fails, find the cause, fix it, and run them again until they pass.", then: { pr: true, notify: true } }),
  },
  {
    id: "dependencies",
    icon: WrenchIcon,
    tone: "--st-working",
    title: "Monday dependencies",
    blurb: "Mondays at 9: updates what's safe to update, runs the tests, and says what it left alone.",
    make: () => ({ name: "Monday dependencies", when: { kind: "schedule", schedule: { every: "weekly", at: "09:00", days: [1], tz: TZ } }, does: "Check the project's dependencies for updates. Update the ones that are safe (patch and minor), run the tests, and list the major updates you left alone with what each would take.", then: { pr: true, notify: true } }),
  },
];
const templates = () => (isLocal() ? [...TEMPLATES.filter((t) => t.make().when?.kind !== "webhook"), ...LOCAL_TEMPLATES] : TEMPLATES);

const runMark = (s: AutomationRun["status"]): TaskMarkState => (s === "running" || s === "starting" ? "working" : s === "done" ? "done" : s === "failed" ? "blocked" : "open");
const RUN_WORD: Record<AutomationRun["status"], string> = { starting: "Starting", running: "Running", done: "Done", failed: "Failed", waiting: "Waiting for your computer", skipped: "Skipped" };
const MODE_WORD: Record<EngineMode, string> = { full: "Full access", edits: "Edits, asks first for commands", plan: "Plan only, changes nothing" };

function toDraft(a: View): Draft {
  const { name, on, who, folder, copy, does, then, limits } = a;
  const when: Draft["when"] = a.when.kind === "webhook" ? { kind: "webhook", ...("url" in a.when && a.when.url ? { url: a.when.url } : {}) } : (a.when as Draft["when"]);
  return { name, on, when, who: { ...who }, folder, copy, does, then: { ...then }, limits: { ...limits } };
}

export function AutomationsPage({
  identity,
  agents,
  recents,
  onOpen,
  onSavedAgents,
}: {
  identity: Identity;
  agents: AgentView[];
  recents: RecentSession[];
  onOpen: (sid: string, invite: string) => void;
  /** The saved agents' own page: what "Who" can pick from. */
  onSavedAgents: () => void;
}) {
  const [list, setList] = useState<View[] | null>(null);
  const [failed, setFailed] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [ask, confirmUI] = useConfirm();
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const got = await api<{ automations: View[] }>(identity, "/api/automations");
      setList(got.automations.sort((a, b) => b.created - a.created));
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, [identity]);
  useEffect(() => {
    void load();
    // A run's state moves on its own (running, then done): read again now and then while the page is open and in sight.
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = async (a: View) => {
    setBusy(a.id);
    try {
      const { run } = await api<{ run: AutomationRun }>(identity, `/api/automations/${a.id}/run`, { method: "POST", body: "{}" });
      await load();
      if (run.sid && run.invite) onOpen(run.sid, run.invite);
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const setOn = async (a: View, on: boolean) => {
    setList((l) => l?.map((x) => (x.id === a.id ? { ...x, on } : x)) ?? l);
    await api(identity, `/api/automations/${a.id}`, { method: "PATCH", body: JSON.stringify({ on }) }).catch((e) => setFailed((e as Error).message));
    void load();
  };

  if (editing)
    return (
      <Editor
        identity={identity}
        agents={agents}
        recents={recents}
        id={editing.id}
        initial={editing.draft}
        runs={list?.find((a) => a.id === editing.id)?.runs ?? []}
        mine={editing.id ? (list?.find((a) => a.id === editing.id)?.mine ?? true) : true}
        onOpen={onOpen}
        onSavedAgents={onSavedAgents}
        onClose={() => (setEditing(null), void load())}
        onSaved={(v) => (setList((l) => [v, ...(l ?? []).filter((x) => x.id !== v.id)]), setEditing({ id: v.id, draft: toDraft(v) }))}
        onDelete={(name) =>
          ask({
            title: `Delete ${name || "this automation"}?`,
            body: "It stops running. The sessions its runs started stay where they are.",
            action: "Delete automation",
            onConfirm: async () => {
              await api(identity, `/api/automations/${editing.id}`, { method: "DELETE" });
              setEditing(null);
              await load();
            },
          })
        }
      />
    );

  const start = (draft: Partial<Draft>) => setEditing({ id: null, draft: { ...blank(), ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) } });

  return (
    <div className="page conns-page automations-page px-6! max-[640px]:px-4!">
      <div className="page-inner">
        {confirmUI}
        <PageHeader
          title="Automations"
          actions={
            <>
              {/* Saved agents are the product's (Agent Studio): the open-source edition's automations run your coding tools. */}
              {!isLocal() && (
                <Tip label="Instructions you saved once, to pick under Who">
                  <Button variant="outline" size="sm" className="h-8 border-[var(--border)] bg-[var(--bg)] px-3 text-[12.5px] shadow-none" onClick={onSavedAgents}>
                    Saved agents
                  </Button>
                </Tip>
              )}
              <Button size="sm" className="h-8 px-3 text-[12.5px]" onClick={() => start({})}>
                <PlusIcon /> New automation
              </Button>
            </>
          }
        />
        {failed && (
          <p role="alert" className="mb-4 rounded-lg border border-[var(--border)] px-3 py-2 text-[13px] text-[var(--red)]">
            {failed}
          </p>
        )}

        {list === null ? (
          <div className="grid gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <Intro onStart={() => start({})} />
        ) : (
          <ul className="grid gap-2" aria-label="Your automations">
            {list.map((a) => (
              <Row key={a.id} a={a} busy={busy === a.id} onEdit={() => setEditing({ id: a.id, draft: toDraft(a) })} onRun={() => void runNow(a)} onToggle={(on) => void setOn(a, on)} onOpen={onOpen} />
            ))}
          </ul>
        )}

        <section className="mt-8" aria-labelledby="auto-templates">
          <h2 id="auto-templates" className="mb-3 text-[13px] font-medium text-[var(--ink-2)]">
            {list?.length ? "Add another from a template" : "Start with one of these"}
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
            {templates().map((t) => {
              const made = t.make();
              return (
                <button key={t.id} type="button" className="auto-tpl group" style={{ "--tone": `var(${t.tone})` } as React.CSSProperties} onClick={() => start(made)}>
                  <span className="auto-tile">
                    <t.icon className="size-4" />
                  </span>
                  <span className="mt-3 text-[14px] font-medium">{t.title}</span>
                  <span className="mt-1 text-[12.5px] leading-snug text-[var(--text-muted)]">{t.blurb}</span>
                  <span className="mt-auto flex items-center justify-between pt-4">
                    <WhenChip when={made.when ?? { kind: "manual" }} />
                    <span className="auto-use">
                      Use <ArrowRightIcon className="size-3.5" />
                    </span>
                  </span>
                </button>
              );
            })}
            <button type="button" className="auto-tpl auto-blank" onClick={() => start({})}>
              <span className="auto-tile">
                <PlusIcon className="size-4" />
              </span>
              <span className="mt-3 text-[14px] font-medium">Start from scratch</span>
              <span className="mt-1 text-[12.5px] leading-snug text-[var(--text-muted)]">Your own trigger, tool and instructions.</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

/** What starts it, as a small chip in its colour: a schedule amber, a webhook blue, a session violet, Run now grey. */
function WhenChip({ when }: { when: Draft["when"] | View["when"] }) {
  const s = when.kind === "schedule" ? when.schedule : null;
  const [Icon, tone, word] =
    when.kind === "schedule"
      ? [ClockIcon, "--st-queued", s!.every === "hourly" ? "Every hour" : s!.every === "daily" ? `Daily ${s!.at}` : s!.days.join() === WEEKDAYS.join() ? `Weekdays ${s!.at}` : `${s!.days.map((d) => DAYS[d]).join(", ")} ${s!.at}`]
      : when.kind === "webhook"
        ? [WebhookIcon, "--st-working", "Webhook"]
        : when.kind === "session"
          ? [ZapIcon, "--st-review", when.on === "failed" ? "When an agent fails" : "When an agent finishes"]
          : [PlayIcon, "--text-muted", "Run now"];
  return (
    <span className="auto-when" style={{ "--tone": `var(${tone})` } as React.CSSProperties}>
      <Icon className="size-3" />
      {word}
    </span>
  );
}

/** Before there are any: what an automation is, drawn as the sentence it reads as, and the way to make one. */
function Intro({ onStart }: { onStart: () => void }) {
  const steps: { label: string; text: string; icon: LucideIcon; tone: string }[] = [
    { label: "When", text: "Every weekday at 9:00", icon: ClockIcon, tone: "--st-queued" },
    { label: "Who", text: "Claude Code, with Codex", icon: ZapIcon, tone: "--st-working" },
    { label: "Does", text: "Sweep the open bugs", icon: BugIcon, tone: "--st-review" },
    { label: "Then", text: "Opens a pull request", icon: GitPullRequestIcon, tone: "--st-done" },
  ];
  return (
    <div className="auto-intro">
      <div className="flex min-w-0 flex-col justify-center gap-3">
        <h2 className="text-[20px] leading-tight font-semibold tracking-[-0.01em]">Put your coding tools on autopilot</h2>
        <p className="max-w-[420px] text-[13.5px] leading-relaxed text-[var(--text-muted)]">
          Say when it runs, which coding tool does it and what it's told. Each run opens a session of its own, so you can see what it did and step in.
        </p>
        <div>
          <Button size="sm" className="h-8 px-3 text-[12.5px]" onClick={onStart}>
            <PlusIcon /> New automation
          </Button>
        </div>
      </div>
      <ol className="auto-steps" aria-label="An example">
        {steps.map((st) => (
          <li key={st.label} style={{ "--tone": `var(${st.tone})` } as React.CSSProperties}>
            <span className="auto-tile">
              <st.icon className="size-3.5" />
            </span>
            <span className="w-12 shrink-0 text-[11.5px] font-medium tracking-wide text-[var(--text-muted)] uppercase">{st.label}</span>
            <span className="truncate text-[13px]">{st.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function WhoMark({ tool, size = 15 }: { tool: EngineTool | "friday"; size?: number }) {
  return tool === "friday" ? <FridayMark size={size} /> : <EngineMark tool={tool} size={size} />;
}

function Row({ a, busy, onEdit, onRun, onToggle, onOpen }: { a: View; busy: boolean; onEdit: () => void; onRun: () => void; onToggle: (on: boolean) => void; onOpen: (sid: string, invite: string) => void }) {
  const last = a.runs[0];
  return (
    <li className={cn("auto-row", !a.on && "opacity-70")}>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--hover)]">
        <WhoMark tool={a.who.tool} />
      </span>
      <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-none" onClick={onEdit} aria-label={`Edit ${a.name}`}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-medium">{a.name}</span>
          <WhenChip when={a.when} />
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] text-[var(--text-muted)]">
          {/* What starts it is the chip above; this line is who does it, and where. */}
          {a.says.who}
          {a.who.tool !== "friday" ? ` · ${a.folder ? a.folder.split(/[\\/]/).filter(Boolean).at(-1) : "a new folder each run"}` : ""}
          {a.mine ? "" : ` · ${a.ownerName}'s`}
        </span>
      </button>
      {last && (
        <button
          type="button"
          className="hidden shrink-0 items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--ink)] sm:flex"
          disabled={!last.sid || !last.invite}
          onClick={() => last.sid && last.invite && onOpen(last.sid, last.invite)}
          title={last.note || RUN_WORD[last.status]}
        >
          <TaskMark state={runMark(last.status)} />
          {RUN_WORD[last.status]} · {relTime(last.at)}
        </button>
      )}
      {a.mine && (
        <>
          <Tip label="Run it now">
            <Button variant="ghost" size="icon-sm" aria-label={`Run ${a.name} now`} disabled={busy} onClick={onRun}>
              <PlayIcon />
            </Button>
          </Tip>
          <Switch checked={a.on} onCheckedChange={onToggle} aria-label={a.on ? `Pause ${a.name}` : `Turn ${a.name} on`} />
        </>
      )}
    </li>
  );
}


/** One line of the sentence: what it is on the left, its controls on the right. */
function Part({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-[var(--border)] px-4 py-4 last:border-b-0 sm:grid-cols-[120px_1fr] sm:gap-4">
      <div>
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-snug text-[var(--text-muted)]">{hint}</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, children, disabled }: { on: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors disabled:opacity-40",
        on ? "border-[var(--ink-2)] bg-[var(--hover)] text-[var(--ink)]" : "border-[var(--border)] text-[var(--ink-2)] hover:bg-[var(--hover)]",
      )}
    >
      {children}
    </button>
  );
}

function Editor({
  identity,
  agents,
  recents,
  id,
  initial,
  runs,
  mine,
  onOpen,
  onSavedAgents,
  onClose,
  onSaved,
  onDelete,
}: {
  identity: Identity;
  agents: AgentView[];
  recents: RecentSession[];
  id: string | null;
  initial: Draft;
  runs: AutomationRun[];
  mine: boolean;
  onOpen: (sid: string, invite: string) => void;
  onSavedAgents: () => void;
  onClose: () => void;
  onSaved: (v: View) => void;
  onDelete: (name: string) => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const machine = useMachine(identity).state;
  useEffect(() => setD(initial), [initial]);
  // Every run it has kept, not only the latest few the list has, and kept current while a run goes.
  const [history, setHistory] = useState(runs);
  useEffect(() => {
    if (!id) return;
    const read = () => void api<{ runs: AutomationRun[] }>(identity, `/api/automations/${id}/runs`).then((r) => setHistory(r.runs), () => {});
    read();
    const t = setInterval(() => document.visibilityState === "visible" && read(), 10_000);
    return () => clearInterval(t);
  }, [id, identity]);
  const set = (change: Partial<Draft>) => setD((x) => ({ ...x, ...change }));
  const who = (change: Partial<Draft["who"]>) => setD((x) => ({ ...x, who: { ...x.who, ...change } }));

  // The coding tools on this computer first; the rest can still be picked, for a computer that has them.
  const installed = useMemo(() => machine.tools.filter((t) => t.path).map((t) => t.tool), [machine.tools]);
  const tools = useMemo(() => {
    const all: EngineTool[] = (Object.keys(ENGINE_NAMES) as EngineTool[]).filter((t) => t !== "acp");
    return [...installed.filter((t) => all.includes(t)), ...all.filter((t) => !installed.includes(t))];
  }, [installed]);
  const friday = d.who.tool === "friday";
  const sched = d.when.kind === "schedule" ? d.when.schedule : null;
  const setSched = (s: Partial<AgentSchedule>) => sched && set({ when: { kind: "schedule", schedule: { ...sched, ...s } } });

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body = JSON.stringify({ ...d, name: d.name.trim() || "Untitled automation" });
      const got = id
        ? await api<{ automation: View }>(identity, `/api/automations/${id}`, { method: "PATCH", body })
        : await api<{ automation: View }>(identity, "/api/automations", { method: "POST", body });
      onSaved(got.automation);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const hookUrl = d.when.kind === "webhook" ? d.when.url : undefined;

  return (
    <div className="page conns-page automations-page px-6! max-[640px]:px-4!">
      <div className="page-inner"><div className="mx-auto w-full max-w-[820px]">
        <div className="mb-4 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 px-2 text-[12.5px]" onClick={onClose}>
            <ArrowLeftIcon /> Automations
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {id && mine && (
              <Button variant="ghost" size="sm" className="h-8 px-2 text-[12.5px] text-[var(--text-muted)]" onClick={() => onDelete(d.name)}>
                <Trash2Icon /> Delete
              </Button>
            )}
            {mine && (
              <Button size="sm" className="h-8 px-3 text-[12.5px]" disabled={saving} onClick={() => void save()}>
                {saving ? "Saving…" : id ? "Save" : "Create automation"}
              </Button>
            )}
          </div>
        </div>
        <h1 className="sr-only">{id ? d.name : "New automation"}</h1>
        <Input
          value={d.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Name it, like “Fix failing CI”"
          aria-label="Name"
          maxLength={80}
          disabled={!mine}
          className="mb-3 h-10 border-transparent bg-transparent px-0 text-[18px] font-semibold shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-[18px]"
        />
        {error && (
          <p role="alert" className="mb-3 text-[13px] text-[var(--red)]">
            {error}
          </p>
        )}

        <fieldset disabled={!mine} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <Part label="When" hint="What starts a run.">
            <PageTabs<Draft["when"]["kind"]>
              label="When"
              value={d.when.kind}
              onChange={(k) =>
                set({
                  when:
                    k === "schedule"
                      ? { kind: "schedule", schedule: { every: "weekly", at: "09:00", days: WEEKDAYS, tz: TZ } }
                      : k === "webhook"
                        ? { kind: "webhook" }
                        : k === "session"
                          ? { kind: "session", sessionId: recents[0]?.sid ?? "", sessionTitle: recents[0]?.alias || recents[0]?.title || "", on: "finished" }
                          : { kind: "manual" },
                })
              }
              options={[
                { value: "schedule", label: "On a schedule" },
                { value: "webhook", label: "A webhook" },
                { value: "session", label: "An agent finishes" },
                { value: "manual", label: "Only Run now" },
              ]}
            />
            {sched && (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={sched.every} onValueChange={(v) => setSched({ every: v as AgentSchedule["every"], ...(v === "weekly" && !sched.days.length ? { days: WEEKDAYS } : {}) })}>
                  <SelectTrigger size="sm" aria-label="How often" className="h-8 w-[150px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="hourly">Every hour</SelectItem>
                    <SelectItem value="daily">Every day</SelectItem>
                    <SelectItem value="weekly">On these days</SelectItem>
                  </SelectContent>
                </Select>
                {sched.every !== "hourly" && (
                  <>
                    <span className="text-[12.5px] text-[var(--text-muted)]">at</span>
                    <Input type="time" value={sched.at} onChange={(e) => setSched({ at: e.target.value })} aria-label="At" className="h-8 w-[120px] text-[12.5px] md:text-[12.5px]" />
                  </>
                )}
                <span className="text-[12px] text-[var(--text-muted)]">{sched.tz}</span>
              </div>
            )}
            {sched?.every === "weekly" && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
                {DAYS.map((day, i) => (
                  <Chip key={day} on={sched.days.includes(i)} onClick={() => setSched({ days: sched.days.includes(i) ? sched.days.filter((x) => x !== i) : [...sched.days, i].sort() })}>
                    {day}
                  </Chip>
                ))}
              </div>
            )}
            {d.when.kind === "webhook" &&
              (hookUrl ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-[var(--hover)] px-2 py-1.5 text-[12px]">{hookUrl}</code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Copy the webhook address"
                      onClick={() => void navigator.clipboard.writeText(hookUrl).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                    </Button>
                  </div>
                  <span className="text-[12px] text-[var(--text-muted)]">POST anything to it, from CI, GitHub or a script: what is posted is what the run is told about. Keep it secret: it is the key.</span>
                </div>
              ) : (
                <span className="text-[12.5px] text-[var(--text-muted)]">Its address shows here once it's created.</span>
              ))}
            {d.when.kind === "session" && (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={d.when.on} onValueChange={(v) => d.when.kind === "session" && set({ when: { ...d.when, on: v as "finished" | "failed" } })}>
                  <SelectTrigger size="sm" aria-label="When the agent" className="h-8 w-[150px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="finished">When it finishes</SelectItem>
                    <SelectItem value="failed">When it fails</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-[12.5px] text-[var(--text-muted)]">in</span>
                <Select
                  value={d.when.sessionId}
                  onValueChange={(sid) => {
                    const r = recents.find((x) => x.sid === sid);
                    if (d.when.kind === "session") set({ when: { ...d.when, sessionId: sid, sessionTitle: r?.alias || r?.title || d.when.sessionTitle } });
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Which session" className="h-8 min-w-[200px] max-w-[320px] text-[12.5px]">
                    <SelectValue placeholder="Pick a session" />
                  </SelectTrigger>
                  <SelectContent>
                    {d.when.sessionId && !recents.some((r) => r.sid === (d.when as { sessionId: string }).sessionId) && <SelectItem value={d.when.sessionId}>{d.when.sessionTitle || "That session"}</SelectItem>}
                    {recents.slice(0, 30).map((r) => (
                      <SelectItem key={r.sid} value={r.sid}>
                        {r.alias || r.title || "Untitled session"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </Part>

          <Part label="Who" hint="Which coding tool does it, and with whom.">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={d.who.tool} onValueChange={(v) => who({ tool: v as Draft["who"]["tool"], team: d.who.team.filter((t) => t !== v) })}>
                <SelectTrigger size="sm" aria-label="Coding tool" className="h-8 min-w-[170px] text-[12.5px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tools.map((t) => (
                    <SelectItem key={t} value={t}>
                      <EngineMark tool={t} size={14} /> {ENGINE_NAMES[t]}
                      {installed.length > 0 && !installed.includes(t) ? " (not on this computer)" : ""}
                    </SelectItem>
                  ))}
                  {!isLocal() && (
                    <SelectItem value="friday">
                      <FridayMark size={14} /> Friday, in the cloud
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
              {!friday && (
                <Select value={d.who.mode} onValueChange={(v) => who({ mode: v as EngineMode })}>
                  <SelectTrigger size="sm" aria-label="What it may do" className="h-8 min-w-[150px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["full", "edits", "plan"] as const).map((m) => (
                      <SelectItem key={m} value={m}>
                        {MODE_WORD[m]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            {friday ? (
              <div className="flex flex-wrap items-center gap-2">
                <Select value={d.who.agentId || "none"} onValueChange={(v) => who({ agentId: v === "none" ? "" : v })}>
                  <SelectTrigger size="sm" aria-label="Saved agent" className="h-8 min-w-[200px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No saved agent</SelectItem>
                    {agents.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button type="button" className="text-[12.5px] text-[var(--text-muted)] underline-offset-2 hover:underline" onClick={onSavedAgents}>
                  Manage saved agents
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] text-[var(--text-muted)]">Helpers, led by {ENGINE_NAMES[d.who.tool as EngineTool]}: it splits the work between them.</span>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Helpers">
                  {(installed.length ? installed : tools.slice(0, 4))
                    .filter((t) => t !== d.who.tool)
                    .map((t) => {
                      const on = d.who.team.includes(t);
                      return (
                        <Chip key={t} on={on} disabled={!on && d.who.team.length >= 4} onClick={() => who({ team: on ? d.who.team.filter((x) => x !== t) : [...d.who.team, t] })}>
                          <EngineMark tool={t} size={13} /> {ENGINE_NAMES[t]}
                        </Chip>
                      );
                    })}
                </div>
              </div>
            )}
          </Part>

          {!friday && (
            <Part label="Where" hint="The folder on your computer it works in.">
              <div className="flex items-center gap-1.5">
                <Input value={d.folder} onChange={(e) => set({ folder: e.target.value })} placeholder="No folder: a new project folder each run" aria-label="Folder" className="h-8 text-[12.5px] md:text-[12.5px]" />
                {window.fridayDesktop?.pickFolder && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 border-[var(--border)] px-2.5 text-[12.5px] shadow-none"
                    onClick={() => void window.fridayDesktop!.pickFolder().then((p) => p && set({ folder: p }))}
                  >
                    <FolderOpenIcon /> Choose
                  </Button>
                )}
              </div>
              {d.folder && (
                <label className="flex items-center gap-2 text-[12.5px]">
                  <Switch checked={d.copy} onCheckedChange={(copy) => set({ copy })} aria-label="Work on its own copy" />
                  Work on its own copy of the folder, so your own work there is left alone
                </label>
              )}
              {!d.folder && d.who.team.length > 0 && <span className="text-[12px] text-[var(--text-muted)]">Helpers need a folder to share: without one, the lead works alone.</span>}
            </Part>
          )}

          <Part label="Does" hint={<>What it's told. <code className="text-[11.5px]">{"{{event}}"}</code> is what started the run.</>}>
            <Textarea value={d.does} onChange={(e) => set({ does: e.target.value })} placeholder="Fix whatever made the build fail, and run the tests again." aria-label="What it does" rows={5} maxLength={8000} className="text-[13px] md:text-[13px]" />
          </Part>

          <Part label="Then" hint="When it's done.">
            {!friday && (
              <label className="flex items-center gap-2 text-[12.5px]">
                <Switch checked={d.then.pr} onCheckedChange={(pr) => set({ then: { ...d.then, pr } })} aria-label="Open a pull request" />
                Open a pull request with the change
              </label>
            )}
            {/* Told through the product's own channels: the open-source edition has none, and its runs show here. */}
            {!isLocal() && (
              <label className="flex items-center gap-2 text-[12.5px]">
                <Switch checked={d.then.notify} onCheckedChange={(notify) => set({ then: { ...d.then, notify } })} aria-label="Tell me" />
                Tell me when a run ends, where my notifications go
              </label>
            )}
          </Part>

          <Part label="Limits" hint="So it can't run away.">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              At most
              <Input
                type="number"
                min={1}
                max={200}
                value={d.limits.perDay}
                onChange={(e) => set({ limits: { ...d.limits, perDay: Math.max(1, Math.min(200, Number(e.target.value) || 1)) } })}
                aria-label="Runs a day"
                className="h-8 w-[72px] text-[12.5px] md:text-[12.5px]"
              />
              runs a day
            </div>
            {!friday && (
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                If my computer isn't on
                <Select value={d.limits.offline} onValueChange={(v) => set({ limits: { ...d.limits, offline: v as "wait" | "skip" } })}>
                  <SelectTrigger size="sm" aria-label="If my computer isn't on" className="h-8 min-w-[200px] text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="wait">wait for it, up to 12 hours</SelectItem>
                    <SelectItem value="skip">skip that run</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </Part>
        </fieldset>

        {id && (
          <section className="mt-6" aria-labelledby="auto-runs">
            <h2 id="auto-runs" className="mb-2 text-[13px] font-medium text-[var(--ink-2)]">
              Runs
            </h2>
            {history.length === 0 ? (
              <p className="text-[12.5px] text-[var(--text-muted)]">No runs yet. {mine ? "Press Run now on the list to try it." : ""}</p>
            ) : (
              <ul className="grid gap-1">
                {history.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      disabled={!r.sid || !r.invite}
                      onClick={() => r.sid && r.invite && onOpen(r.sid, r.invite)}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[12.5px] hover:bg-[var(--hover)] disabled:hover:bg-transparent"
                    >
                      <TaskMark state={runMark(r.status)} />
                      <span className="font-medium">{RUN_WORD[r.status]}</span>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">
                        {r.trigger}
                        {r.note ? ` · ${r.note}` : ""}
                      </span>
                      <span className="shrink-0 text-[var(--text-muted)]">{relTime(r.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div></div>
    </div>
  );
}
