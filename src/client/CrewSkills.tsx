/**
 * The crew's skills on the page (team-skills.ts): the Skills dialog from a crew chat's header, the Skills tab on a teammate's page,
 * a teammate's proposal as a card in the Crew room (skill.proposed), "Save as a skill" under a finished run, and the skill picker on
 * a workflow step. One list, read from /api/teammates/skills in both editions and kept here for every place that shows it.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ListChecksIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SessionEvent } from "../types.js";
import type { SkillView } from "../team-skills.js";
import type { TeammateView } from "../teammates.js";
import { Face, mateOn, useTeamNow } from "./Teammates.js";
import "./crew-skills.css";

type Skill = SkillView & { keep?: boolean };

// ── The list, kept for every place that shows it ────────────────────────────────────────────────────────────────────────────

let skills: Skill[] | null = null;
let version = 0;
const subs = new Set<() => void>();
const tell = () => (version++, subs.forEach((f) => f()));

/** The skills API, as the person: its answer, or throws with what the server said. */
async function call<T = { skills: Skill[] }>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`/api/teammates/skills${path}`, { method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const got = (await r.json().catch(() => ({}))) as T & { error?: string; skills?: Skill[] };
  if (!r.ok) throw new Error(got.error ?? "Couldn't reach Friday. Try again in a moment.");
  if (got.skills) (skills = got.skills), tell();
  return got;
}

export const refreshSkills = () => call("").catch(() => null);

/** The crew's skills, read when first shown and after each change here; null until read. */
export function useSkills(): Skill[] | null {
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => version,
  );
  useEffect(() => void refreshSkills(), []);
  return skills;
}

/** Kept, and open to this teammate: to all, kept for it, or kept for teammates no longer in the crew (team-skills.ts usableBy). */
const usable = (s: Skill, mate: string, mates: readonly TeammateView[]) => {
  if (s.proposed || s.revises) return false;
  const live = (s.for ?? []).filter((id) => mates.some((m) => m.id === id));
  return !live.length || live.includes(mate);
};

const timesUsed = (s: Skill) => (s.uses ? `Used ${s.uses === 1 ? "once" : `${s.uses} times`}${s.lastUsed ? `, last by ${s.lastUsed.by}` : ""}` : "Not used yet");
/** Whose it is, said on the hosted service where it isn't yours: "Maya Chen's", or the teammate's that wrote it and its keeper. */
const whose = (s: Skill) => (s.mine ? "" : s.author.kind === "person" ? `${s.author.name}'s` : `${s.author.keeper?.name ?? s.author.name}'s`);

// ── A skill as a row, and its editor ───────────────────────────────────────────────────────────────────────────────────────

function ForFaces({ s, mates }: { s: Skill; mates: readonly TeammateView[] }) {
  const kept = (s.for ?? []).flatMap((id) => mates.find((m) => m.id === id) ?? []);
  if (!kept.length) return <span>Everyone</span>;
  return (
    <span className="sk-for-faces" title={`Kept for ${kept.map((m) => m.name).join(", ")}`}>
      {kept.slice(0, 4).map((m) => (
        <Face key={m.id} seed={m.look ?? m.name} size={16} />
      ))}
      <span>{kept.length === 1 ? kept[0]!.name : `${kept.length} teammates`}</span>
    </span>
  );
}

function SkillRow({ s, mates, onOpen }: { s: Skill; mates: readonly TeammateView[]; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="sk-row" onClick={onOpen}>
        <span className="sk-row-main">
          <span className="sk-row-name">{s.name}</span>
          <span className="sk-row-when">{s.when}</span>
        </span>
        <span className="sk-row-meta">
          <ForFaces s={s} mates={mates} />
          <span>{timesUsed(s)}</span>
          {whose(s) && <span>{whose(s)}</span>}
        </span>
      </button>
    </li>
  );
}

type Draft = { name: string; when: string; steps: string; inputs: string; check: string; for: string[] };
const draftOf = (s?: Skill | null, forMate?: string): Draft => ({ name: s?.name ?? "", when: s?.when ?? "", steps: s?.steps ?? "", inputs: s?.inputs ?? "", check: s?.check ?? "", for: s?.for ?? (forMate ? [forMate] : []) });

/** A skill made or changed: its words, who it is for, and Save; Delete for one already there. Read-only where it isn't yours. */
function SkillEditor({ s, forMate, mates, onDone }: { s: Skill | null; forMate?: string; mates: readonly TeammateView[]; onDone: () => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(s, forMate));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sure, setSure] = useState(false);
  const mine = !s || s.mine;
  const set = (c: Partial<Draft>) => (setD((x) => ({ ...x, ...c })), setErr(""));
  const go = (p: Promise<unknown>) => {
    setBusy(true);
    void p.then(onDone, (e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };
  const save = () => go(s ? call(`/${s.id}`, "PATCH", d) : call("", "POST", d));
  const field = (label: string, hint: ReactNode, input: ReactNode) => (
    <label className="tm-field">
      <span>{label}</span>
      {input}
      {hint && <small>{hint}</small>}
    </label>
  );
  return (
    <form
      className="sk-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (mine && !busy) save();
      }}
    >
      {field("Name", null, <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Cut a release" maxLength={60} readOnly={!mine} autoFocus={!s} />)}
      {field("When to use it", "One line. Teammates see this with every turn, and fetch the steps when the work fits.", <Input value={d.when} onChange={(e) => set({ when: e.target.value })} placeholder="A version is ready to ship and main is green." maxLength={240} readOnly={!mine} />)}
      {field(
        "Steps",
        "Short numbered steps work best: a teammate on a small model follows them as well.",
        <Textarea value={d.steps} onChange={(e) => set({ steps: e.target.value })} placeholder={"1. Run the tests.\n2. Bump the version in package.json.\n3. Tag it and push the tag."} className="min-h-[148px] text-[13px] leading-relaxed md:text-[13px]" maxLength={8000} readOnly={!mine} />,
      )}
      <div className="sk-edit-pair">
        {field("Inputs", "Optional.", <Input value={d.inputs} onChange={(e) => set({ inputs: e.target.value })} placeholder="The version number" maxLength={1000} readOnly={!mine} />)}
        {field("Done when", "Optional: the check that proves it worked.", <Input value={d.check} onChange={(e) => set({ check: e.target.value })} placeholder="The tag shows on GitHub" maxLength={1000} readOnly={!mine} />)}
      </div>
      {mates.length > 0 && (
        <div className="tm-field">
          <span>Who uses it</span>
          <div className="sk-for" role="group" aria-label="Who uses it">
            <button type="button" className="sk-for-chip" aria-pressed={!d.for.length} disabled={!mine} onClick={() => set({ for: [] })}>
              Everyone
            </button>
            {mates.map((m) => {
              const on = d.for.includes(m.id);
              return (
                <button key={m.id} type="button" className="sk-for-chip" aria-pressed={on} disabled={!mine} onClick={() => set({ for: on ? d.for.filter((x) => x !== m.id) : [...d.for, m.id] })}>
                  <Face seed={m.look ?? m.name} size={16} />
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {err && (
        <p className="tm-err" role="alert">
          {err}
        </p>
      )}
      <div className="sk-edit-acts">
        {s && mine && (
          <button type="button" className="tm-banner-btn danger" disabled={busy} onClick={() => (sure ? go(call(`/${s.id}`, "DELETE")) : setSure(true))}>
            {sure ? `Delete “${s.name}”` : "Delete"}
          </button>
        )}
        {s && !mine && <span className="tm-sub">{whose(s)}: theirs to change.</span>}
        <span className="sk-grow" />
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {mine ? "Cancel" : "Close"}
        </Button>
        {mine && (
          <Button type="submit" size="sm" disabled={busy || !d.name.trim() || !d.when.trim() || !d.steps.trim()}>
            {s ? "Save" : "Add skill"}
          </Button>
        )}
      </div>
    </form>
  );
}

// ── A teammate's proposal ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Keep or Drop on a proposal, and its steps on Read: the card's body, in the Crew room and in the Skills dialog alike. */
function Proposal({ s, by, was }: { s: Skill | undefined; by: string; was?: Skill }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = (p: Promise<unknown>) => (setBusy(true), void p.catch((e: Error) => setErr(e.message)).finally(() => setBusy(false)));
  if (!s) return null;
  return (
    <>
      {open && (
        <div className="sk-steps">
          {/* A change: when it's used, as it is and as it would be; a new one's when is on the card already. */}
          {was && was.when !== s.when && (
            <>
              <p className="sk-steps-now">{was.when}</p>
              <p className="sk-steps-when">{s.when}</p>
            </>
          )}
          <pre>{s.steps}</pre>
          {s.inputs && <p>Inputs: {s.inputs}</p>}
          {s.check && <p>Done when: {s.check}</p>}
        </div>
      )}
      {err && (
        <p className="tm-err" role="alert">
          {err}
        </p>
      )}
      <span className="tm-proposed-acts">
        <button type="button" className="tm-banner-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide steps" : "Read steps"}
        </button>
        {s.keep && (
          <button type="button" className="tm-banner-btn" disabled={busy} onClick={() => act(call(`/${s.id}`, "PATCH", { keep: true }))}>
            Keep
          </button>
        )}
        {s.mine && (
          <button type="button" className="tm-banner-btn danger" disabled={busy} onClick={() => act(call(`/${s.id}`, "DELETE"))} title={`Drop ${by}'s ${was ? "change" : "skill"}`}>
            Drop
          </button>
        )}
      </span>
    </>
  );
}

/** A skill a teammate proposed (skill.proposed), in the Crew room: Keep, Drop, or read its steps first. */
export function ProposedSkill({ ev, stamp }: { ev: SessionEvent; stamp: ReactNode }) {
  const list = useSkills();
  if (ev.body.type !== "skill.proposed") return null;
  const b = ev.body;
  const s = list?.find((x) => x.id === b.id);
  const was = b.revises ? list?.find((x) => x.id === b.revises) : undefined;
  // Kept: as a skill of its own, or (a change) folded into the one it changed and gone.
  const kept = !!s && !s.proposed;
  const by = mateOn(b.madeBy.lane);
  const name = by?.name ?? b.madeBy.name;
  const said = b.revises ? (
    <>
      <b>{name}</b> suggests a change to <b>{b.name}</b>.
    </>
  ) : (
    <>
      <b>{name}</b> proposed a skill: <b>{b.name}</b>. {b.when}
    </>
  );
  return (
    <div className="tm-proposed sk-proposed" data-gone={list && !s ? "true" : undefined}>
      <span className="tm-proposed-face">{by ? <Face seed={by.look ?? by.name} size={30} /> : <ListChecksIcon className="size-4" />}</span>
      <div className="tm-proposed-text">
        <p>{said}</p>
        {s && !kept && <p className="tm-sub">{b.revises ? "Until you keep it, the crew uses the skill as it is." : "Nobody uses it until you keep it."}</p>}
        {kept && <p className="tm-sub">Kept. The crew sees it from their next turn.</p>}
        {list && !s && <p className="tm-sub">{b.revises && was && was.updated >= ev.ts ? "Kept into the skill." : "Since dropped or kept."}</p>}
        {s && !kept && <Proposal s={s} by={name} was={was} />}
      </div>
      <span className="tt-stamp">{stamp}</span>
    </div>
  );
}

// ── The Skills dialog and the teammate's tab ──────────────────────────────────────────────────────────────────────────────

/** The crew's skills, to read, make and change: every one, or (`mate`) those a teammate may use, with new ones kept for it. */
export function SkillsPanel({ mate }: { mate?: TeammateView }) {
  const list = useSkills();
  const t = useTeamNow();
  const mates = t?.teammates ?? [];
  const [editing, setEditing] = useState<string | "new" | null>(null);
  if (!list) return <p className="tm-panel-empty">Reading the crew's skills…</p>;
  const kept = list.filter((s) => !s.proposed && !s.revises);
  const shown = mate ? kept.filter((s) => usable(s, mate.id, mates)) : kept;
  const waiting = list.filter((s) => s.proposed && s.keep);
  if (editing) {
    const s = editing === "new" ? null : (list.find((x) => x.id === editing) ?? null);
    return <SkillEditor key={editing} s={s} forMate={mate?.id} mates={mates} onDone={() => setEditing(null)} />;
  }
  // Someone else's teammate on the hosted service: its skills to read, none to make for it.
  let canMake = true;
  return (
    <div className="sk-panel">
      {!mate && waiting.length > 0 && (
        <section>
          <h4 className="tm-day-head">Waiting on you</h4>
          <ul className="sk-waiting">
            {waiting.map((s) => (
              <li key={s.id} className="tm-proposed sk-proposed">
                <div className="tm-proposed-text">
                  <p>
                    <b>{s.author.name}</b> {s.revises ? "suggests a change to" : "proposed"} <b>{s.name}</b>.
                  </p>
                  <Proposal s={s} by={s.author.name} was={s.revises ? list.find((x) => x.id === s.revises) : undefined} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="sk-panel-head">
        <p className="sk-lede">
          {mate
            ? `${mate.name} sees each skill's name and when to use it with every turn, and fetches the steps when the work fits.`
            : "Ways of doing things the crew repeats. Teammates see each one's name and when to use it, fetch the steps when the work fits, and propose new ones after a run goes well."}
        </p>
        {canMake && (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")}>
            <PlusIcon className="size-3.5" /> {mate ? `New skill for ${mate.name}` : "New skill"}
          </Button>
        )}
      </div>
      {shown.length ? (
        <ul className="sk-list">
          {shown.map((s) => (
            <SkillRow key={s.id} s={s} mates={mates} onOpen={() => setEditing(s.id)} />
          ))}
        </ul>
      ) : (
        <p className="tm-panel-empty">{mate && kept.length ? `None of the crew's skills is open to ${mate.name}.` : "No skills yet. Write one here, or press Save as a skill under a run that went well."}</p>
      )}
    </div>
  );
}

/** The Skills button in a crew chat's header, and its dialog. */
export function SkillsButton() {
  const [open, setOpen] = useState(false);
  const waiting = skillsWaiting(useSkills());
  return (
    <>
      <button type="button" className="panel-tab icon tm-hd-btn" aria-label={waiting ? `Skills: ${waiting} waiting on you` : "Skills"} title="Skills: how the crew does things it repeats" onClick={() => setOpen(true)}>
        <ListChecksIcon className="size-[17px]" />
        {waiting > 0 && <span className="tm-hd-n">{waiting}</span>}
      </button>
      {open && <SkillsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** Proposed skills waiting for the person to keep or drop. */
export const skillsWaiting = (list: Skill[] | null) => list?.filter((s) => s.proposed && s.keep).length ?? 0;

/** The crew's skills in a dialog: from the header's button, or the room's ⋯ menu (TeamControls.tsx RoomMore). */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sk-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Skills</DialogTitle>
          <DialogDescription className="sr-only">The crew's skills: make, change and keep them.</DialogDescription>
        </DialogHeader>
        <SkillsPanel />
      </DialogContent>
    </Dialog>
  );
}

// ── Save as a skill, and a workflow step's skill ──────────────────────────────────────────────────────────────────────────

/** Under a teammate's finished run: asks it to write what it did up as a skill (save_skill), which comes back as a card to keep. */
export function SaveAsSkill({ sid, lane }: { sid: string; lane: string }) {
  const [state, setState] = useState<"" | "busy" | "asked" | string>("");
  const m = mateOn(lane);
  if (!m) return null;
  // On the hosted service only your own teammate: someone else's runs on its keeper's plan.
  if (state === "asked") return <span className="tt-chip">Asked {m.name} to write it up</span>;
  return (
    <button
      type="button"
      className="tt-open sk-save"
      disabled={state === "busy"}
      title={state && state !== "busy" ? state : `Ask ${m.name} to write what it did up as a skill the crew can repeat. It comes back as a card to keep.`}
      onClick={() => {
        setState("busy");
        void call("/write-up", "POST", { sid, lane }).then(
          () => setState("asked"),
          (e: Error) => setState(e.message),
        );
      }}
    >
      <ListChecksIcon className="size-3.5" /> Save as a skill
    </button>
  );
}

/** The line a workflow step's instructions carry for a skill: the teammate fetches its steps with use_skill. */
const SKILL_LINE = /^Use the skill “[^”]*” \(use_skill\)\.\n?/;
const NONE = "-";

/** A workflow step's skill: picked, its line leads the step's instructions; none, the line goes. Nothing when the crew has none. */
export function StepSkill({ does, onChange }: { does: string; onChange: (does: string) => void }) {
  const list = useSkills();
  const kept = (list ?? []).filter((s) => !s.proposed && !s.revises);
  if (!kept.length) return null;
  const now = /^Use the skill “([^”]*)”/.exec(does)?.[1] ?? "";
  return (
    <Select
      value={kept.some((s) => s.name === now) ? now : NONE}
      onValueChange={(v) => {
        const rest = does.replace(SKILL_LINE, "");
        onChange(v !== NONE ? `Use the skill “${v}” (use_skill).\n${rest}` : rest);
      }}
    >
      <SelectTrigger size="sm" aria-label="Use a skill for this step" className="sk-step h-8 w-full text-[13px]">
        <ListChecksIcon className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start" collisionPadding={8} className="max-w-[calc(100vw-16px)]">
        <SelectItem value={NONE}>No skill</SelectItem>
        {kept.map((s) => (
          <SelectItem key={s.id} value={s.name}>
            Use “{s.name}”
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
