import { useMemo, useState } from "react";
import { mergeFindings, reviewOrder, type AgreedFinding } from "../code-review.js";
import type { PullRequest } from "../runner/workspace.js";
import { ENGINE_NAMES } from "../types.js";
import { FileIcon } from "./fileIcons.js";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import { reviews } from "./prWatch.js";

/**
 * A guided tour of a pull request (Arun, 2026-10-25, tier 2: "a PR review page with an AI-guided tour"): its files one at a time,
 * in the order a careful reviewer would read them (code-review.ts reviewOrder: what touches payments, auth or data first, the
 * biggest changes next, the small safe ones last), each with why it is where it is and what the agents' review found in it.
 * Next, next, done: a review that is a walk, not a wall.
 */

type File = NonNullable<PullRequest["files"]>[number];

export function ReviewTour({ pr, files, onClose }: { pr: PullRequest; files: File[]; onClose: () => void }) {
  const steps = useMemo(() => reviewOrder(files.map((f) => ({ ...f, status: "modified", patch: "" }))), [files]);
  const run = reviews.get(pr.url);
  const found = useMemo(() => (run ? mergeFindings(run.results) : []), [run]);
  const [at, setAt] = useState(0);
  const [seen, setSeen] = useState<Set<number>>(() => new Set([0]));
  const step = steps[Math.min(at, steps.length - 1)];
  if (!step) return null;
  const f = step.file;
  const here = found.filter((x) => x.path && (x.path === f.path || f.path.endsWith(`/${x.path}`) || x.path.endsWith(`/${f.path}`)));
  const go = (i: number) => {
    const n = Math.max(0, Math.min(steps.length - 1, i));
    setAt(n);
    setSeen((s) => new Set([...s, n]));
  };
  const size = f.additions + f.deletions;
  const sizeWord = size > 300 ? "a big change" : size > 60 ? "a medium change" : "a small change";
  const byWord = (x: AgreedFinding) => (x.by.length > 1 ? `${x.by.map((t) => ENGINE_NAMES[t]).join(" and ")} agree` : ENGINE_NAMES[x.by[0]!]);
  return (
    <section className="tour" aria-label="Guided tour of the changes">
      <div className="tour-head">
        <Icon name="compass" size={14} />
        <span>
          <b>
            {at + 1} of {steps.length}
          </b>{" "}
          · {at === 0 ? "start here" : at === steps.length - 1 ? "last one" : "next"}
        </span>
        <span className="tour-dots" aria-hidden>
          {steps.map((_, i) => (
            <i key={i} className={i === at ? "on" : seen.has(i) ? "done" : ""} />
          ))}
        </span>
        <button type="button" className="icon-btn tiny tour-x" aria-label="End the tour" title="End the tour" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="tour-file">
        <FileIcon path={f.path} size={14} />
        <span>{f.path}</span>
        <span className="diff-add">+{f.additions}</span> <span className="diff-del">−{f.deletions}</span>
      </div>
      <div className="tour-why">
        {step.risks.map((r) => (
          <span key={r} className="risk">
            {r}
          </span>
        ))}
        <span>{sizeWord}</span>
        {step.risks.length === 0 && size <= 60 && <span>quick to read</span>}
      </div>
      {here.length > 0 ? (
        <ul className="tour-findings">
          {here.slice(0, 4).map((x, i) => (
            <li key={i} className={x.severity}>
              <b>{x.title}</b>
              {x.line ? ` (line ${x.line})` : ""}: {x.detail} <span className="muted">· {byWord(x)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="tour-note">
          {run && run.results.length ? "The agents' review found nothing here." : "No agent has reviewed this pull request yet; run the agent review above and the tour shows what it found, file by file."}
          {step.risks.length ? ` Read it closely anyway: it ${step.risks.map((r) => r.toLowerCase()).join(", ")}.` : ""}
        </p>
      )}
      <div className="tour-acts">
        <span className="muted small">{seen.size} of {steps.length} seen</span>
        <button type="button" className="btn ghost small" onClick={() => openOutside(`${pr.url}/files`)}>
          <Icon name="external" size={12} /> On GitHub
        </button>
        <button type="button" className="btn ghost small" disabled={at === 0} onClick={() => go(at - 1)}>
          Back
        </button>
        {at < steps.length - 1 ? (
          <button type="button" className="btn primary small" onClick={() => go(at + 1)}>
            Next
          </button>
        ) : (
          <button type="button" className="btn primary small" onClick={onClose}>
            <Icon name="check" size={12} /> Done
          </button>
        )}
      </div>
    </section>
  );
}
