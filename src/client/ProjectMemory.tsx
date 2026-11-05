import { useEffect, useState } from "react";
import type { BrainEntry, BrainKind, BrainRepo } from "../brain.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import type { Identity } from "./storage.js";
import { Segmented, Switch, relTime, useConfirm } from "./ui.js";
import { RuleForm, RuleHow, type RuleDraft } from "./RuleForm.js";

const KINDS: [BrainKind, string][] = [
  ["decision", "Decision"],
  ["pitfall", "Pitfall"],
  ["convention", "Convention"],
  ["fact", "Fact"],
];
/** Every kind's name, a correction's included: those come from runs, so they aren't among the kinds a person adds. */
const KIND_NAME: Record<BrainKind, string> = { correction: "Correction", decision: "Decision", pitfall: "Pitfall", convention: "Convention", fact: "Fact" };

/**
 * Project memory (brain.ts): what agents learned working on each repository, from every finished run and every save_lesson,
 * and what each agent starting there is briefed with. Here a person reads all of it and puts it right: edits a lesson, pins one
 * so it is never dropped, forgets one, or adds one (org memory, 2026-10-31: "a wrong or outdated memory corrected").
 */
export function ProjectMemory({ identity }: { identity: Identity }) {
  // `mayToggle`: whether this person may turn learning off or on for the workspace (its admins and owners); absent on your own computer, where it is yours.
  const [state, setState] = useState<{ enabled: boolean; repos: BrainRepo[]; mayToggle?: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrainEntry[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState<{ text: string; kind: BrainKind }>({ text: "", kind: "decision" });
  /** A rule being written (`new`) or put right (its entry's id), on the open repo (rules.ts). */
  const [rule, setRule] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ask, confirmUI] = useConfirm();
  const load = () => void api<{ enabled: boolean; repos: BrainRepo[]; mayToggle?: boolean }>(identity, "/api/brain").then(setState, (e: Error) => setError(e.message));
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps
  const q = (repo: string, more = "") => `repo=${encodeURIComponent(repo)}${more}`;
  const loadRepo = (repo: string) => void api<{ entries: BrainEntry[] }>(identity, `/api/brain/entries?${q(repo)}`).then((r) => setEntries(r.entries), (e: Error) => setError(e.message));
  useEffect(() => (open ? loadRepo(open) : setEntries(null)), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
      if (open) loadRepo(open);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  if (!state) return null;
  // Pinned first, then mistakes agents were corrected for, then what agents were told most, then the newest; retired ones apart.
  const sorted = [...(entries ?? [])].filter((e) => !e.retired).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(b.kind === "correction") - Number(a.kind === "correction") || b.uses - a.uses || b.at - a.at);
  const retired = (entries ?? []).filter((e) => e.retired).sort((a, b) => b.retired!.at - a.retired!.at);
  const check = (repo: string, e: BrainEntry, take: boolean) => void act(() => api(identity, `/api/brain/check?${q(repo, `&id=${e.id}`)}`, { method: "POST", body: JSON.stringify({ take }) }));
  const putRule = (repo: string, id: string | null, r: RuleDraft) => void act(() => api(identity, `/api/brain/rule?${q(repo, id ? `&id=${id}` : "")}`, { method: "POST", body: JSON.stringify(r) })).then((ok) => ok && setRule(null));
  return (
    <div className="settings-block set-card mem-card brain-card">
      {confirmUI}
      <div className="set-row">
        <div>
          <div className="set-label">Project memory</div>
          <div className="muted small">
            {state.enabled
              ? "What agents learned working on each repository: decisions, pitfalls and their fixes, conventions. Every agent starting on one, in any tool, is told what bears on its task. Agents add to it as they work; put anything wrong right here."
              : "Agents learn nothing from their runs, and nobody is briefed. What is listed is kept until you delete it."}
            {state.mayToggle === false && " Only admins and owners turn learning off or on."}
          </div>
        </div>
        <Switch label="Learn from every run" on={state.enabled} disabled={state.mayToggle === false} onChange={(on) => void act(() => api(identity, "/api/brain/settings", { method: "POST", body: JSON.stringify({ enabled: on }) }))} />
      </div>
      {state.repos.length === 0 ? (
        <p className="mem-empty">Nothing learned yet. It fills in as agents finish work in a repository.</p>
      ) : (
        <div className="brain-repos">
          {state.repos.map((r) => (
            <div key={r.key} className="brain-repo">
              <button type="button" className="brain-repo-head" aria-expanded={open === r.key} onClick={() => setOpen(open === r.key ? null : r.key)}>
                <Icon name={open === r.key ? "chevronDown" : "chevronRight"} size={13} />
                <span className="brain-repo-name">{r.name}</span>
                <span className="muted small">
                  {r.count} lesson{r.count === 1 ? "" : "s"}{r.sessions ? ` · from ${r.sessions} session${r.sessions === 1 ? "" : "s"}` : ""} · {relTime(r.at) === "now" ? "just now" : `${relTime(r.at)} ago`}
                </span>
              </button>
              {open === r.key && (
                <div className="brain-entries">
                  {sorted.map((e) => (
                    <div key={e.id} className="mem-row brain-row">
                      <span className={`brain-kind k-${e.kind}`}>{KIND_NAME[e.kind] ?? e.kind}</span>
                      {editing?.id === e.id ? (
                        <form
                          className="brain-edit"
                          onSubmit={(ev) => {
                            ev.preventDefault();
                            void act(() => api(identity, `/api/brain/entry?${q(r.key, `&id=${e.id}`)}`, { method: "PATCH", body: JSON.stringify({ text: editing.text }) })).then((ok) => ok && setEditing(null));
                          }}
                        >
                          <input autoFocus value={editing.text} maxLength={400} aria-label="The lesson" onChange={(ev) => setEditing({ id: e.id, text: ev.target.value })} onKeyDown={(ev) => ev.key === "Escape" && setEditing(null)} />
                          <button type="submit" className="btn primary small">Save</button>
                        </form>
                      ) : (
                        <div className="mem-text">{e.text}</div>
                      )}
                      <div className="mem-meta">
                        {e.from.tool === "person" ? `Added by ${e.from.name}` : `Learned by ${e.from.name}`}
                        {e.from.title ? ` in “${e.from.title}”` : ""} · {relTime(e.at) === "now" ? "just now" : `${relTime(e.at)} ago`}
                        {e.uses ? ` · told ${e.uses} time${e.uses === 1 ? "" : "s"}` : ""}
                      </div>
                      {e.kind === "correction" &&
                        (rule === e.id && e.check?.how && e.check.how !== "command" ? (
                          <RuleForm start={{ text: e.text, how: e.check.how, pattern: e.check.pattern ?? "", ...(e.check.only ? { only: e.check.only } : {}), ...(e.check.except ? { except: e.check.except } : {}) }} onCancel={() => setRule(null)} onSave={(d) => putRule(r.key, e.id, d)} />
                        ) : (
                          <Proof e={e} onCheck={(take) => check(r.key, e, take)} onEdit={() => setRule(e.id)} />
                        ))}
                      <span className="brain-acts">
                        <button type="button" className={`icon-btn tiny${e.pinned ? " on" : ""}`} aria-pressed={!!e.pinned} aria-label={e.pinned ? "Unpin" : "Pin: never dropped"} title={e.pinned ? "Pinned: never dropped" : "Pin: never dropped"} onClick={() => void act(() => api(identity, `/api/brain/entry?${q(r.key, `&id=${e.id}`)}`, { method: "PATCH", body: JSON.stringify({ pinned: !e.pinned }) }))}>
                          <Icon name="flag" size={13} />
                        </button>
                        <button type="button" className="icon-btn tiny" aria-label="Edit" title="Edit" onClick={() => setEditing({ id: e.id, text: e.text })}>
                          <Icon name="pencil" size={13} />
                        </button>
                        <button type="button" className="icon-btn tiny" aria-label="Forget this" title="Forget this" onClick={() => ask({ title: "Forget this lesson?", body: e.text.slice(0, 140), action: "Forget lesson", onConfirm: () => void act(() => api(identity, `/api/brain/entry?${q(r.key, `&id=${e.id}`)}`, { method: "DELETE" })) })}>
                          <Icon name="x" size={13} />
                        </button>
                      </span>
                    </div>
                  ))}
                  {retired.length > 0 && (
                    <details className="brain-retired">
                      <summary>
                        {retired.length} retired: out of agents' briefings
                      </summary>
                      {retired.map((e) => (
                        <div key={e.id} className="mem-row brain-row">
                          <span className={`brain-kind k-${e.kind}`}>{KIND_NAME[e.kind] ?? e.kind}</span>
                          <div className="mem-text">{e.text}</div>
                          <div className="mem-meta">
                            {e.retired!.why} · {relTime(e.retired!.at) === "now" ? "just now" : `${relTime(e.retired!.at)} ago`}
                          </div>
                          <span className="brain-acts">
                            <button type="button" className="btn ghost small" onClick={() => void act(() => api(identity, `/api/brain/entry?${q(r.key, `&id=${e.id}`)}`, { method: "PATCH", body: JSON.stringify({ restore: true }) }))}>
                              Bring back
                            </button>
                          </span>
                        </div>
                      ))}
                    </details>
                  )}
                  {/* A rule every change here is checked for (rules.ts), written by hand. */}
                  {rule === "new" ? (
                    <RuleForm start={{ text: "", how: "lines", pattern: "" }} onCancel={() => setRule(null)} onSave={(d) => putRule(r.key, null, d)} saveWord="Add the rule" />
                  ) : (
                    <button type="button" className="btn ghost small brain-add-rule" onClick={() => setRule("new")}>
                      <Icon name="plus" size={13} /> Add a rule every change is checked for
                    </button>
                  )}
                  <form
                    className="mem-add brain-add"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      const t = draft.text.trim();
                      if (!t) return;
                      void act(() => api(identity, `/api/brain/entries?${q(r.key)}`, { method: "POST", body: JSON.stringify(draft) })).then((ok) => ok && setDraft({ ...draft, text: "" }));
                    }}
                  >
                    <input value={draft.text} maxLength={400} placeholder={`Something every agent on ${r.name} should know…`} aria-label="A lesson to add" onChange={(ev) => setDraft({ ...draft, text: ev.target.value })} />
                    <Segmented<BrainKind> value={draft.kind} onChange={(kind) => setDraft({ ...draft, kind })} options={KINDS} />
                    <button type="submit" className="btn primary small" disabled={!draft.text.trim()}>
                      Add
                    </button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="form-error set-note" role="alert">
        {error}
      </p>
    </div>
  );
}

/**
 * Whether a correction is holding: how often the mistake was corrected, how often agents have been told since without it coming
 * back, and the check behind it when there is one (how often it ran and caught it), with the one thing to do about it.
 */
function Proof({ e, onCheck, onEdit }: { e: BrainEntry; onCheck: (take: boolean) => void; onEdit: () => void }) {
  const seen = e.seen ?? 1;
  const since = Math.max(0, e.uses - (e.usesAtSeen ?? 0));
  const c = e.check;
  // A rule read off the change (rules.ts): how it is checked, how often it caught something, and its own few things to do.
  if (c?.how && c.how !== "command" && c.pattern) {
    return (
      <div className="brain-proof">
        <span>
          {c.state === "added" ? "Every change is checked" : c.state === "declined" ? "Not checked" : "Offered as a rule"}: <RuleHow check={{ how: c.how, pattern: c.pattern, ...(c.only ? { only: c.only } : {}), ...(c.except ? { except: c.except } : {}) }} />
          {c.state === "added" && c.runs ? ` · ${c.runs} change${c.runs === 1 ? "" : "s"} checked, caught ${c.caught ?? 0}` : ""}
        </span>
        {c.state === "proposed" && (
          <button type="button" className="btn primary small" onClick={() => onCheck(true)}>
            Keep it
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={onEdit}>
          Edit
        </button>
        {c.state === "added" ? (
          <button type="button" className="btn ghost small" onClick={() => onCheck(false)}>
            Turn off
          </button>
        ) : c.state === "declined" ? (
          <button type="button" className="btn ghost small" onClick={() => onCheck(true)}>
            Turn on
          </button>
        ) : (
          <button type="button" className="btn ghost small" onClick={() => onCheck(false)}>
            No
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="brain-proof">
      <span>
        Corrected {seen === 1 ? "once" : seen === 2 ? "twice" : `${seen} times`}
        {since ? ` · agents told ${since} time${since === 1 ? "" : "s"} since, not back yet` : ""}
      </span>
      {c?.state === "added" && (
        <>
          <span>
            Friday runs <code>{c.command}</code> after changes{c.runs ? ` · ran ${c.runs} time${c.runs === 1 ? "" : "s"}, caught it ${c.caught ?? 0}` : ""}
          </span>
          <button type="button" className="btn ghost small" onClick={() => onCheck(false)}>
            Stop running it
          </button>
        </>
      )}
      {c?.state === "proposed" && (
        <>
          <span>
            It came back after agents were told: add <code>{c.command}</code> as a check?
          </span>
          <button type="button" className="btn primary small" onClick={() => onCheck(true)}>
            Add the check
          </button>
          <button type="button" className="btn ghost small" onClick={() => onCheck(false)}>
            No
          </button>
        </>
      )}
      {(c?.state === "suggested" || c?.state === "declined") && (
        <>
          <span>
            {c.state === "declined" ? "Check not wanted" : "A check could catch it"}: <code>{c.command}</code>
          </span>
          <button type="button" className="btn ghost small" onClick={() => onCheck(true)}>
            Add it
          </button>
        </>
      )}
    </div>
  );
}
