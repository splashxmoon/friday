import { useEffect, useState } from "react";
import { detectRule } from "../repo-rules.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";
import "./rule-card.css";

/**
 * "Save as a rule": under a message of yours that states a convention in this repo ("we use pnpm, not npm", "never X"), a small card
 * offers to keep it in .friday/rules.md, where every coding tool in the repo follows it (Arun, 2026-11-19: "correct the agent once
 * ... and it becomes a rule every tool follows"). Nothing is saved without a press, and what is saved shows with Edit and Undo for as
 * long as the chat is open. What the card did is remembered here, by message, so a reload shows the same.
 */
type Mark = { saved: string } | { dismissed: true };
// One small map per chat (the newest fifty messages' marks), not a key per message that nothing ever clears.
const mapKey = (sid: string) => `friday.rules.${sid}`;
const KEEP_MARKS = 50;
const marks = (sid: string): Record<string, Mark> => {
  try {
    const v = JSON.parse(localStorage.getItem(mapKey(sid)) ?? "null") as Record<string, Mark> | null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const recall = (sid: string, seq: number): Mark | null => marks(sid)[seq] ?? null;
const remember = (sid: string, seq: number, m: Mark | null) => {
  try {
    const all = marks(sid);
    if (m) all[seq] = m;
    else delete all[seq];
    const keep = Object.keys(all).sort((x, y) => Number(x) - Number(y)).slice(-KEEP_MARKS);
    localStorage.setItem(mapKey(sid), JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]!]))));
  } catch {
    // Not remembered: the card still works for as long as it is open.
  }
};

const Mark_ = () => (
  <svg className="rc-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3.5h12v17l-6-4.5-6 4.5z" />
  </svg>
);

export function RuleCard({ text, sid, seq, cwd, identity, from, latest }: { text: string; sid: string; seq: number; cwd: string; identity: Identity; from: string; latest: boolean }) {
  const offered = detectRule(text);
  const [mark, setMark] = useState<Mark | null>(() => recall(sid, seq));
  const [gone, setGone] = useState(false);
  const [rule, setRule] = useState(offered ?? "");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<boolean | null>(null);
  const [err, setErr] = useState("");

  // Already in the file (said before, or saved from the IDE): no card for what is kept.
  useEffect(() => {
    if (!offered || mark) return;
    let live = true;
    void hostApi<{ rules: { text: string }[] }>(identity, `/api/runner/rules.read?cwd=${encodeURIComponent(cwd)}`).then(
      (r) => live && setKnown((r?.rules ?? []).some((x) => x.text.toLowerCase() === offered.toLowerCase())),
      () => live && setKnown(false),
    );
    return () => void (live = false);
  }, [offered, cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!offered) return null;
  const saved = mark && "saved" in mark ? mark.saved : null;
  // An offer is for the latest message only; a saved one stays (its Undo, its Edit).
  if (!saved && (!latest || (mark && "dismissed" in mark) || known !== false)) return null;

  const write = async (op: Record<string, unknown>) => {
    setBusy(true);
    setErr("");
    try {
      return (await hostApi<{ removed?: boolean }>(identity, "/api/runner/rules.write", { method: "POST", body: JSON.stringify({ cwd, op }) })) ?? {};
    } catch {
      setErr("Couldn't write the rules file. Try once more.");
      return null;
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    const body = rule.trim();
    if (!body || !(await write({ op: "add", text: body, from }))) return;
    const m: Mark = { saved: body };
    remember(sid, seq, m);
    setMark(m);
    setEditing(false);
  };
  const undo = async () => {
    const r = saved ? await write({ op: "removeText", text: saved }) : null;
    if (!r) return;
    // Reworded or removed in the rules file since: nothing was undone, and the card says so instead of vanishing as if it had.
    if (r.removed === false) return setGone(true);
    remember(sid, seq, { dismissed: true });
    setMark({ dismissed: true });
  };
  const resave = async () => {
    const body = rule.trim();
    if (!saved || !body) return;
    if (body !== saved) {
      // In place: the rule keeps its place, its switch and its date.
      const r = await write({ op: "editText", text: saved, to: body });
      if (!r) return;
      if (r.removed === false) return setGone(true);
      const m: Mark = { saved: body };
      remember(sid, seq, m);
      setMark(m);
    }
    setEditing(false);
  };
  const close = () => (remember(sid, seq, { dismissed: true }), setMark({ dismissed: true }), setGone(false));
  const form = editing && (
    <form className="rc-edit" onSubmit={(e) => (e.preventDefault(), void (saved ? resave() : save()))}>
      <input className="rc-input" value={rule} onChange={(e) => setRule(e.target.value)} aria-label="The rule" autoFocus maxLength={200} onKeyDown={(e) => e.key === "Escape" && (setEditing(false), setRule(saved ?? offered))} />
      <button type="submit" className="rc-btn rc-primary" disabled={busy || !rule.trim()}>Save</button>
      <button type="button" className="rc-btn" onClick={() => (setEditing(false), setRule(saved ?? offered))}>Cancel</button>
    </form>
  );

  return (
    <div className="rule-card" data-saved={saved ? "" : undefined} role="group" aria-label={saved ? "Saved as a rule" : "Save as a rule"}>
      <Mark_ />
      <div className="rc-body">
        {form || (
          <p className="rc-text">
            <b>{saved ? "Saved as a rule:" : "Save as a rule:"}</b> {saved ?? rule}
            {saved && <span className="rc-note">Every tool follows it in this repo.</span>}
          </p>
        )}
        {gone && <p className="rc-err" role="alert">That rule was changed in the rules file, so there was nothing to change here.</p>}
        {err && <p className="rc-err" role="alert">{err}</p>}
      </div>
      {!editing && (
        <div className="rc-actions">
          {gone ? (
            <button type="button" className="rc-btn" onClick={close}>Close</button>
          ) : saved ? (
            <>
              <button type="button" className="rc-btn" onClick={() => (setRule(saved), setEditing(true))}>Edit</button>
              <button type="button" className="rc-btn" disabled={busy} onClick={() => void undo()}>Undo</button>
            </>
          ) : (
            <>
              <button type="button" className="rc-btn rc-primary" disabled={busy} onClick={() => void save()}>Save</button>
              <button type="button" className="rc-btn" onClick={() => setEditing(true)}>Edit</button>
              <button type="button" className="rc-btn" onClick={() => close()}>Dismiss</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
