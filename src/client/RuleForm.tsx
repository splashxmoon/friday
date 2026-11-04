import { useState } from "react";
import { globsOf, ruleRegex, type RuleCheck } from "../rules.js";
import { Segmented } from "./ui.js";

/**
 * A rule for a repo, written or put right by a person (rules.ts; Arun, 2026-11-03: "Rules that stick"): what it says, how it is
 * checked on every change, the pattern, and for lines the files it reads. From the offer under a correction (its Edit) and from
 * Project memory (Add a rule, Edit).
 */
export type RuleDraft = { text: string } & RuleCheck;

const HOW: [RuleCheck["how"], string][] = [
  ["lines", "Lines it adds"],
  ["runs", "Commands it runs"],
  ["paths", "Files it touches"],
];
const HELP: Record<RuleCheck["how"], string> = {
  lines: "A regular expression. No line a change adds may match it.",
  runs: "A regular expression. No command an agent runs may match it.",
  paths: "Files or folders, comma-separated: generated/, db/migrations/**, *.lock. No change may touch them.",
};

/** A rule's own words, its `code` drawn as code. */
export function RuleText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : p))}
    </>
  );
}

/** How a rule is checked, in words with only its pattern as code: "no line it adds may match `\bconsole\.log\b`". */
export function RuleHow({ check }: { check: RuleCheck }) {
  const where = [check.only?.length ? `in ${check.only.join(", ")}` : "", check.except?.length ? `except ${check.except.join(", ")}` : ""].filter(Boolean).join(", ");
  if (check.how === "paths") return <>no change may touch <code>{globsOf(check.pattern).join(", ")}</code></>;
  if (check.how === "runs") return <>no command an agent runs may match <code>{check.pattern}</code></>;
  return (
    <>
      no line a change adds may match <code>{check.pattern}</code>
      {where ? ` (${where})` : ""}
    </>
  );
}

export function RuleForm({ start, busy, onSave, onCancel, saveWord = "Save rule" }: { start: RuleDraft; busy?: boolean; onSave: (r: RuleDraft) => void; onCancel: () => void; saveWord?: string }) {
  const [r, setR] = useState<RuleDraft>(start);
  const [only, setOnly] = useState((start.only ?? []).join(", "));
  const [except, setExcept] = useState((start.except ?? []).join(", "));
  const bad = r.how !== "paths" && r.pattern.trim() && !ruleRegex(r.pattern.trim()) ? "That isn't a regular expression Friday can read." : "";
  const ok = r.text.trim().length >= 3 && r.pattern.trim() && !bad;
  return (
    <form
      className="rule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        onSave({ text: r.text.trim(), how: r.how, pattern: r.pattern.trim(), ...(r.how === "lines" && globsOf(only).length ? { only: globsOf(only) } : {}), ...(r.how === "lines" && globsOf(except).length ? { except: globsOf(except) } : {}) });
      }}
    >
      <label className="rule-row">
        <span className="rule-label">Rule</span>
        <input autoFocus value={r.text} maxLength={300} placeholder="Use pnpm, not npm." onChange={(e) => setR({ ...r, text: e.target.value })} onKeyDown={(e) => e.key === "Escape" && onCancel()} />
      </label>
      <div className="rule-row">
        <span className="rule-label">Checks</span>
        <Segmented value={r.how} options={HOW} onChange={(how) => setR({ ...r, how })} className="rule-how" />
      </div>
      <label className="rule-row">
        <span className="rule-label">{r.how === "paths" ? "Files" : "Pattern"}</span>
        <span className="rule-field">
          <input className="mono" value={r.pattern} maxLength={300} spellCheck={false} aria-invalid={!!bad} onChange={(e) => setR({ ...r, pattern: e.target.value })} onKeyDown={(e) => e.key === "Escape" && onCancel()} />
          <small className={bad ? "bad" : undefined}>{bad || HELP[r.how]}</small>
        </span>
      </label>
      {r.how === "lines" && (
        <div className="rule-row">
          <span className="rule-label">Files read</span>
          <span className="rule-field rule-pair">
            <input className="mono" value={only} placeholder="Every file" spellCheck={false} aria-label="Only these files" onChange={(e) => setOnly(e.target.value)} />
            <input className="mono" value={except} placeholder="Except *.test.ts, scripts/" spellCheck={false} aria-label="Except these files" onChange={(e) => setExcept(e.target.value)} />
          </span>
        </div>
      )}
      <div className="rule-acts">
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn primary small" disabled={!ok || busy}>
          {saveWord}
        </button>
      </div>
    </form>
  );
}
