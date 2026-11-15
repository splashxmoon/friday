import { useState } from "react";
import { ClockIcon, PlayIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { describeCheckIn, EVERY_HOURS, MAX_CHECKINS, nextRun, type CheckIn } from "../teammate-checkins.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { mateOn, refreshTeam } from "./Teammates.js";
import { Switch, useConfirm } from "./ui.js";
import { TimeField } from "./time-field.js";

/**
 * A crew mate's routines (Arun, 2026-11-15: "add routines too, make it very advanced also not native controls or anything too and
 * make it nicely designed... combine the check ins with the routines"): what it does on its own, on a schedule. Each is a card that
 * turns on and off where it stands and says when it runs next; opened, it is edited with Friday's own controls (a schedule's kinds
 * as one segmented row, the time on steppers, the days as chips), where it runs (its main chat, or a new thread each time), and
 * whether a run with nothing new stays quiet. Run now runs one at once. Kept as the crew mate's check-ins, which they always were.
 */
type Every = CheckIn["every"];
const KINDS: { id: Every; label: string }[] = [
  { id: "hourly", label: "Hourly" },
  { id: "every", label: "Every few hours" },
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays" },
  { id: "weekly", label: "Weekly" },
];
const DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Starters for a first routine, each a whole one to keep or change. */
const STARTERS: { name: string; text: string; every: Every; at: string; days: number[]; hours?: number; where?: "thread" }[] = [
  { name: "Morning stand-up", text: "What you did since the last stand-up, what you're on next, and anything blocking you.", every: "weekdays", at: "09:00", days: [] },
  { name: "Weekly review", text: "Sum up this week's work: what shipped, what's still open, and what you'd do first next week.", every: "weekly", at: "16:00", days: [5], where: "thread" },
  { name: "Keep an eye out", text: "Look over what changed in the projects you work in since you last checked, and flag anything that needs me.", every: "every", hours: 4, at: "09:00", days: [] },
];

/** "9:00 AM" from "09:00", in this computer's way of saying times. */
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h!, m!, 0, 0);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
/** A routine's schedule in words: "Weekdays at 9:00 AM", "Every 4 hours", "Mondays and Fridays at 4:00 PM". */
export function scheduleWords(c: Pick<CheckIn, "every" | "at" | "days" | "hours">): string {
  if (c.every === "hourly") return "Every hour, on the hour";
  if (c.every === "every") return `Every ${c.hours ?? 4} hours`;
  if (c.every === "daily") return `Every day at ${clock(c.at)}`;
  if (c.every === "weekdays") return `Weekdays at ${clock(c.at)}`;
  const names = c.days.map((d) => `${DAY_NAMES[d]}s`);
  return `${names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} at ${clock(c.at)}`;
}
/** "Today 9:00 AM", "Tomorrow 9:00 AM", "Fri 4:00 PM". */
const when = (d: Date) => {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86_400_000);
  const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today ${t}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${t}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
};

export function MateRoutines({ identity, lane }: { identity: Identity; lane: string }) {
  const m = mateOn(lane);
  const [editing, setEditing] = useState<CheckIn | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  if (!m) return null;
  const list = m.checkins ?? [];
  const save = (next: CheckIn[]) =>
    api(identity, `/api/teammates/${m.id}`, { method: "PATCH", body: JSON.stringify({ checkins: next }), headers: { "Content-Type": "application/json" } }).then(() => refreshTeam(identity));
  const flip = (c: CheckIn, on: boolean) => (setErr(""), void save(list.map((x) => (x.id === c.id ? { ...x, ...(on ? { off: undefined } : { off: true as const }) } : x))).catch((e: Error) => setErr(e.message)));
  const runNow = (c: CheckIn) => {
    setErr("");
    void api(identity, `/api/teammates/${m.id}/routine`, { method: "POST", body: JSON.stringify({ id: c.id }), headers: { "Content-Type": "application/json" } })
      .then(() => refreshTeam(identity))
      .then(() => setNote(`${c.name || "That routine"} is running now${c.where === "thread" ? ", in a new thread" : ", in the main chat"}.`))
      .catch((e: Error) => setErr(e.message || "It didn't run. Try again."));
  };
  if (editing)
    return (
      <RoutineEditor
        key={editing.id}
        name={m.name}
        start={editing}
        isNew={!list.some((x) => x.id === editing.id)}
        onCancel={() => setEditing(null)}
        onSave={(c) => save(list.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? { ...c, ...(x.last ? { last: x.last } : {}) } : x)) : [...list, c]).then(() => setEditing(null))}
        onDelete={(c) => save(list.filter((x) => x.id !== c.id)).then(() => setEditing(null))}
        onRun={(c) => (runNow(c), setEditing(null))}
      />
    );
  const blank = (s?: (typeof STARTERS)[number]): CheckIn => ({ id: newId(), tz: zone(), text: "", every: "weekdays", at: "09:00", days: [], ...(s ? { name: s.name, text: s.text, every: s.every, at: s.at, days: s.days, ...(s.hours ? { hours: s.hours } : {}), ...(s.where ? { where: s.where } : {}) } : {}) });
  return (
    <div className="rt">
      <div className="rt-head">
        <p>What {m.name} does on its own, on a schedule, in your time.</p>
        {list.length > 0 && list.length < MAX_CHECKINS && (
          <Button size="sm" variant="outline" onClick={() => setEditing(blank())}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            New routine
          </Button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="rt-empty">
          <p className="rt-empty-title">No routines yet</p>
          <p>Start from one of these, or write your own.</p>
          <ul className="rt-starters">
            {STARTERS.map((s) => (
              <li key={s.name}>
                <button type="button" className="rt-starter" onClick={() => setEditing(blank(s))}>
                  <b>{s.name}</b>
                  <span>{scheduleWords({ ...s, hours: s.hours ?? 4 })}</span>
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" onClick={() => setEditing(blank())}>
            <PlusIcon className="size-3.5" aria-hidden="true" />
            Write your own
          </Button>
        </div>
      ) : (
        <ul className="rt-list">
          {list.map((c) => {
            const next = nextRun(c);
            return (
              <li key={c.id} className="rt-card" data-off={c.off ? "" : undefined}>
                <button type="button" className="rt-card-main" onClick={() => setEditing(c)} aria-label={`Edit ${c.name || c.text.split("\n")[0]}`}>
                  <b>{c.name || c.text.split("\n")[0]}</b>
                  <span className="rt-card-sched">
                    {scheduleWords(c)}
                    {c.where === "thread" ? " · new thread each time" : ""}
                  </span>
                  <span className="rt-card-next">{c.off ? "Off" : next ? `Next ${when(next)}` : "Not in the next week"}</span>
                </button>
                <span className="rt-card-acts">
                  <button type="button" className="rt-icon" aria-label={`Run ${c.name || "it"} now`} title="Run now" onClick={() => runNow(c)}>
                    <PlayIcon aria-hidden="true" />
                  </button>
                  <Switch label={`${c.name || "Routine"} on`} on={!c.off} onChange={(on) => flip(c, on)} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {note && (
        <p className="rt-note" role="status">
          {note}
        </p>
      )}
      {err && (
        <p className="msd-err" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function RoutineEditor({ name, start, isNew, onCancel, onSave, onDelete, onRun }: { name: string; start: CheckIn; isNew: boolean; onCancel: () => void; onSave: (c: CheckIn) => Promise<void>; onDelete: (c: CheckIn) => Promise<void>; onRun: (c: CheckIn) => void }) {
  const [c, setC] = useState<CheckIn>(start);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ask, confirmUI] = useConfirm();
  const put = (p: Partial<CheckIn>) => (setErr(""), setC((x) => ({ ...x, ...p })));
  const timed = c.every === "daily" || c.every === "weekdays" || c.every === "weekly";
  const next = nextRun({ ...c, off: undefined, last: undefined });
  const go = () => {
    if (!c.text.trim()) return setErr(`Say what ${name} does each time.`);
    if (c.every === "weekly" && !c.days.length) return setErr("Pick at least one day.");
    setBusy(true);
    void onSave({ ...c, name: c.name?.trim() || undefined, text: c.text.trim(), tz: c.tz || zone() })
      .catch((e: Error) => setErr(e.message || "That didn't save. Try again."))
      .finally(() => setBusy(false));
  };
  return (
    <div className="rt rt-edit">
      <label className="rt-field">
        <span>Name</span>
        <Input value={c.name ?? ""} maxLength={60} placeholder="Morning stand-up" onChange={(e) => put({ name: e.target.value })} />
      </label>
      <label className="rt-field">
        <span>What {name} does</span>
        <Textarea value={c.text} maxLength={2000} rows={3} placeholder="What you did since the last one, what's next, and anything blocking you." onChange={(e) => put({ text: e.target.value })} />
      </label>
      <div className="rt-field">
        <span>When</span>
        {/* One card: how often across its top, then a labelled row for each thing that kind asks (the days, the hours between,
            the time), and when it runs next along its foot (Arun, 2026-11-15: "please make this design better.... like the when
            section"). */}
        <div className="rt-when">
          <div className="rt-seg rt-when-kinds" role="radiogroup" aria-label="How often">
            {KINDS.map((k) => (
              <button key={k.id} type="button" role="radio" aria-checked={c.every === k.id} className="rt-seg-opt" onClick={() => put({ every: k.id, ...(k.id === "weekly" && !c.days.length ? { days: [1] } : {}), ...(k.id === "every" && !c.hours ? { hours: 4 } : {}) })}>
                {k.label}
              </button>
            ))}
          </div>
          {(c.every === "every" || c.every === "weekly" || timed) && (
            <div className="rt-when-rows">
              {c.every === "every" && (
                <div className="rt-when-row">
                  <span className="rt-when-label">Every</span>
                  <div className="rt-chips" role="radiogroup" aria-label="Every how many hours">
                    {EVERY_HOURS.map((h) => (
                      <button key={h} type="button" role="radio" aria-checked={(c.hours ?? 4) === h} className="rt-chip" onClick={() => put({ hours: h })}>
                        {h} hours
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {c.every === "weekly" && (
                <div className="rt-when-row">
                  <span className="rt-when-label">On</span>
                  <div className="rt-chips rt-days" role="group" aria-label="Days">
                    {DAY_SHORT.map((d, i) => (
                      <button key={i} type="button" aria-pressed={c.days.includes(i)} aria-label={DAY_NAMES[i]} title={DAY_NAMES[i]} className="rt-chip rt-day" onClick={() => put({ days: c.days.includes(i) ? c.days.filter((x) => x !== i) : [...c.days, i].sort() })}>
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {timed && (
                <div className="rt-when-row">
                  <span className="rt-when-label">At</span>
                  <TimeField value={c.at} onChange={(at) => put({ at })} />
                </div>
              )}
            </div>
          )}
          <div className="rt-when-foot">
            <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="rt-when-next">{next ? <>Next run <b>{when(next)}</b></> : "It won't run in the next week"}</span>
            <span className="rt-when-tz" title="Times are in this computer's time zone">{c.tz || zone()}</span>
          </div>
        </div>
      </div>
      <div className="rt-field">
        <span>Where it runs</span>
        <div className="rt-seg rt-seg-two" role="radiogroup" aria-label="Where it runs">
          <button type="button" role="radio" aria-checked={c.where !== "thread"} className="rt-seg-opt" onClick={() => put({ where: undefined })}>
            Its main chat
          </button>
          <button type="button" role="radio" aria-checked={c.where === "thread"} className="rt-seg-opt" onClick={() => put({ where: "thread" })}>
            A new thread each time
          </button>
        </div>
      </div>
      <div className="rt-toggle">
        <span>
          <b>Quiet when there's nothing new</b>
          <small>{c.quiet === false ? `Off: ${name} always says what it found.` : `${name} says nothing at all when nothing changed since the last run.`}</small>
        </span>
        <Switch label="Quiet when there's nothing new" on={c.quiet !== false} onChange={(on) => put({ quiet: on ? undefined : false })} />
      </div>
      {err && (
        <p className="msd-err" role="alert">
          {err}
        </p>
      )}
      <div className="rt-foot">
        {!isNew && (
          <button
            type="button"
            className="msd-remove"
            onClick={() =>
              ask({
                title: `Delete ${start.name || "this routine"}?`,
                body: `${name} stops running it. What it said before stays in its chat.`,
                action: "Delete routine",
                onConfirm: () => onDelete(start),
              })
            }
          >
            Delete routine
          </button>
        )}
        <span className="rt-foot-acts">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          {!isNew && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onRun(start)}>
              <PlayIcon className="size-3.5" aria-hidden="true" />
              Run now
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={go}>
            {busy ? "Saving…" : isNew ? "Add routine" : "Save"}
          </Button>
        </span>
      </div>
      {confirmUI}
    </div>
  );
}
