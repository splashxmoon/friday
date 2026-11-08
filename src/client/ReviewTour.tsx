import { useEffect, useMemo, useRef, useState } from "react";
import { mergeFindings, reviewOrder, type AgreedFinding } from "../code-review.js";
import type { PullRequest } from "../runner/workspace.js";
import type { PrFile } from "../runner/pr-actions.js";
import { ENGINE_NAMES } from "../types.js";
import { FileIcon } from "./fileIcons.js";
import { hostApi } from "./local.js";
import { openOutside } from "./openOutside.js";
import { reviews, useReviews } from "./prWatch.js";
import type { Identity } from "./storage.js";
import { isTyping } from "./ui.js";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, CompassIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * A guided tour of a pull request (Arun, 2026-10-25, tier 2: "a PR review page with an AI-guided tour"): its files one at a time,
 * in the order a careful reviewer would read them (code-review.ts reviewOrder: what touches auth, payments or data first, the small
 * mechanical ones last), each with why it is where it is, what the agents' review found in it, and its diff.
 *
 * Rebuilt 2026-11-07 (Arun: "fix the guided tour it is bugged and poorly designed"): it took the `.tour` class of the app's own
 * onboarding tour and so covered the whole window, empty but for a file name; it walked names without their changes; and it
 * said "Read it closely anyway: it infra.". Now it sits where the file list was, with the reading plan beside the file in front
 * of you, the diff itself (from GitHub, through this computer's login), and the findings that point at its lines.
 */

type File = NonNullable<PullRequest["files"]>[number];

/** What makes a file worth a careful look, as the end of a sentence: "it touches auth and changes dependencies". */
const PHRASE: Record<string, string> = {
  Migration: "is a migration",
  "CI config": "changes CI config",
  Dependencies: "changes dependencies",
  Infra: "changes infrastructure",
  "Deletes a test": "deletes a test",
};
const phrase = (risks: string[]) => {
  // "Touches auth" and its kind read as they are; the rest have their words here.
  const ps = risks.map((r) => PHRASE[r] ?? r.charAt(0).toLowerCase() + r.slice(1));
  return ps.length > 1 ? `${ps.slice(0, -1).join(", ")} and ${ps.at(-1)}` : (ps[0] ?? "");
};

/** One line of a diff, numbered as the file is after the change (before it, for a line taken away). */
type Line = { kind: "hunk" | "add" | "del" | "same"; text: string; n?: number };
export function diffLines(patch: string): Line[] {
  const out: Line[] = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      out.push({ kind: "hunk", text: h[3]!.trim() });
    } else if (raw.startsWith("+")) out.push({ kind: "add", text: raw.slice(1), n: newN++ });
    else if (raw.startsWith("-")) out.push({ kind: "del", text: raw.slice(1), n: oldN++ });
    else if (raw.startsWith("\\")) continue;
    else out.push({ kind: "same", text: raw.slice(1), n: (oldN++, newN++) });
  }
  return out;
}

const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

export function ReviewTour({ identity, pr, files, onClose }: { identity: Identity; pr: PullRequest; files: File[]; onClose: () => void }) {
  useReviews();
  // The diffs, asked of GitHub once the tour opens; until then (or if it can't say) the tour still walks the files.
  const [diffs, setDiffs] = useState<Map<string, PrFile> | null>(null);
  const [diffError, setDiffError] = useState("");
  useEffect(() => {
    let live = true;
    hostApi<{ files: PrFile[] }>(identity, "/api/runner/pr.files", { method: "POST", body: JSON.stringify({ url: pr.url }) }).then(
      (r) => live && setDiffs(new Map(r.files.map((f) => [f.path, f]))),
      (e: Error) => live && (setDiffs(new Map()), setDiffError(e.message || "GitHub didn't answer.")),
    );
    return () => void (live = false);
  }, [identity, pr.url]);

  const steps = useMemo(
    () => reviewOrder(files.map((f) => ({ ...f, status: diffs?.get(f.path)?.status ?? "modified", patch: diffs?.get(f.path)?.patch ?? "" }))),
    [files, diffs],
  );
  const run = reviews.get(pr.url);
  const found = useMemo(() => (run ? mergeFindings(run.results) : []), [run]);
  const [at, setAt] = useState(0);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const step = steps[Math.min(at, steps.length - 1)];
  const path = step?.file.path ?? "";
  useEffect(() => {
    if (path) setSeen((s) => (s.has(path) ? s : new Set(s).add(path)));
  }, [path]);
  const go = (i: number) => setAt(Math.max(0, Math.min(steps.length - 1, i)));

  // ← and → walk it, Escape ends it, while nothing is being typed.
  const keys = useRef({ go, at, onClose });
  keys.current = { go, at, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector(".overlay")) return;
      if (e.key === "ArrowRight") keys.current.go(keys.current.at + 1);
      else if (e.key === "ArrowLeft") keys.current.go(keys.current.at - 1);
      else if (e.key === "Escape") keys.current.onClose();
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Opened from the files' heading, it is brought into view: below the card, it opened out of sight on a short window.
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  const diffBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    diffBox.current?.scrollTo({ top: 0 });
  }, [path]);
  if (!step) return null;
  const f = step.file;
  const here = found.filter((x) => x.path && sameFile(x.path, f.path));
  const lines = diffs?.get(f.path)?.patch ? diffLines(diffs.get(f.path)!.patch!) : null;
  const flagged = new Set(here.map((x) => x.line).filter((n): n is number => !!n));
  const size = f.additions + f.deletions;
  const byWord = (x: AgreedFinding) => (x.by.length > 1 ? `${x.by.map((t) => ENGINE_NAMES[t]).join(" and ")} agree` : ENGINE_NAMES[x.by[0]!]);
  const last = at === steps.length - 1;
  const toLine = (n: number) => diffBox.current?.querySelector<HTMLElement>(`[data-line="${n}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  // Why it is where it is in the order, in a sentence.
  const why = step.risks.length
    ? `${at === 0 ? "First, because" : "Read it closely:"} it ${phrase(step.risks)}.`
    : step.mechanical
      ? "Lines moved or imports only: a quick look."
      : size > 300
        ? `A big change: ${size} lines.`
        : size > 60
          ? `A medium change: ${size} lines.`
          : `A small change: ${size} line${size === 1 ? "" : "s"}.`;

  return (
    <section ref={root} className="rt @container flex min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]" aria-label="Guided tour of the changes">
      {/* Where you are: the tour, how far through, and the way out. */}
      <header className="flex min-w-0 items-center gap-2.5 border-b border-[var(--border)] px-3.5 py-2.5">
        <CompassIcon className="size-4 shrink-0 text-[var(--ink-2)]" aria-hidden />
        <span className="text-[13px] font-semibold text-[var(--ink)]">Guided tour</span>
        <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
          {at + 1} of {steps.length}
        </span>
        <span className="h-1 min-w-12 max-w-48 flex-1 overflow-hidden rounded-full bg-[var(--hover)]" aria-hidden>
          <span className="block h-full rounded-full bg-[var(--ink)] transition-[width] duration-[var(--dass-med)]" style={{ width: `${(seen.size / steps.length) * 100}%` }} />
        </span>
        <span className="ml-auto hidden text-[12px] text-[var(--text-muted)] @min-[560px]:inline" aria-hidden>
          <kbd>←</kbd> <kbd>→</kbd> to move
        </span>
        <Button variant="ghost" size="icon-xs" aria-label="End the tour" title="End the tour (Esc)" className="text-[var(--text-muted)] hover:text-[var(--ink)]" onClick={onClose}>
          <XIcon />
        </Button>
      </header>

      <div className="grid min-w-0 grid-cols-1 @min-[620px]:grid-cols-[200px_minmax(0,1fr)]">
        {/* The reading plan: every file in the order to read it, what is seen ticked, the one in front of you marked. */}
        <ol className="m-0 hidden max-h-[520px] list-none flex-col gap-px overflow-y-auto border-r border-[var(--border)] p-1.5 @min-[620px]:flex" aria-label="Reading order">
          {steps.map((s, i) => (
            <li key={s.file.path}>
              <button
                type="button"
                aria-current={i === at || undefined}
                onClick={() => go(i)}
                title={s.file.path}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-[var(--ink-2)] hover:bg-[var(--hover)] aria-[current=true]:bg-[var(--hover)] aria-[current=true]:text-[var(--ink)]"
              >
                <span className="grid size-3.5 shrink-0 place-items-center">
                  {seen.has(s.file.path) && i !== at ? <CheckIcon className="size-3 text-[var(--text-muted)]" /> : <span className={cn("size-1.5 rounded-full", s.risks.length ? "bg-[var(--dass-needs)]" : "bg-[var(--border-strong)]")} />}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{base(s.file.path)}</span>
                {found.some((x) => x.path && sameFile(x.path, s.file.path)) && <span className="shrink-0 text-[11px] font-medium text-[var(--red)]" title="The agents found something here">!</span>}
              </button>
            </li>
          ))}
        </ol>

        <div className="flex min-w-0 flex-col gap-3 p-3.5">
          {/* The file in front of you, and why it comes here. */}
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <FileIcon path={f.path} size={15} />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--ink)]" title={f.path}>
                <span className="text-[var(--text-muted)]">{dir(f.path)}</span>
                {base(f.path)}
              </span>
              <span className="shrink-0 font-mono text-[12px] tabular-nums">
                <span className="text-[var(--green)]">+{f.additions}</span> <span className="text-[var(--red)]">−{f.deletions}</span>
              </span>
            </div>
            <p className={cn("m-0 pl-[23px] text-[13px]", step.risks.length ? "text-[var(--ink)]" : "text-[var(--text-muted)]")}>{why}</p>
          </div>

          {/* What your agents found in it, each pointing at its line below. */}
          {here.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Found in this file">
              {here.slice(0, 5).map((x, i) => (
                <li key={i} className="flex min-w-0 items-start gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-[13px]">
                  <span className={cn("mt-[3px] shrink-0 rounded px-1.5 text-[11px] font-medium", x.severity === "high" ? "bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-[var(--red)]" : "bg-[var(--hover)] text-[var(--ink-2)]")}>
                    {x.severity === "high" ? "High" : x.severity === "medium" ? "Medium" : "Low"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-[var(--ink)]">{x.title}</span>
                    {x.detail && <span className="text-[var(--ink-2)]"> {x.detail}</span>}
                    <span className="text-[12px] text-[var(--text-muted)]"> · {byWord(x)}</span>
                  </span>
                  {x.line && lines?.some((l) => l.n === x.line && l.kind !== "del") && (
                    <button type="button" className="link-btn shrink-0 text-[12px]" onClick={() => toLine(x.line!)}>
                      Line {x.line}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-[12px] text-[var(--text-muted)]">{run?.results.length ? "Your agents found nothing in this file." : "Run Agent review above the files and what it finds shows here, file by file."}</p>
          )}

          {/* The change itself. */}
          <div ref={diffBox} className="max-h-[420px] min-w-0 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg)]" aria-label={`Diff of ${f.path}`}>
            {diffs === null ? (
              <p className="m-0 px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">Reading the changes from GitHub…</p>
            ) : !lines ? (
              <p className="m-0 px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
                {diffError ? `Couldn't read the changes: ${diffError}` : "GitHub doesn't show this file's changes (a binary file, or too big)."}{" "}
                <button type="button" className="link-btn" onClick={() => openOutside(`${pr.url}/files`)}>
                  See it on GitHub
                </button>
              </p>
            ) : (
              <table className="w-full border-collapse font-mono text-[12px] leading-[18px]">
                <tbody>
                  {lines.map((l, i) =>
                    l.kind === "hunk" ? (
                      <tr key={i} className="bg-[var(--hover)] text-[var(--text-muted)]">
                        <td className="w-10 px-2 py-0.5 text-right select-none">⋯</td>
                        <td className="truncate px-2 py-0.5">{l.text}</td>
                      </tr>
                    ) : (
                      <tr
                        key={i}
                        data-line={l.kind !== "del" ? l.n : undefined}
                        className={cn(
                          l.kind === "add" && "bg-[color-mix(in_srgb,var(--green)_9%,transparent)]",
                          l.kind === "del" && "bg-[color-mix(in_srgb,var(--red)_8%,transparent)]",
                          l.kind !== "del" && l.n !== undefined && flagged.has(l.n) && "shadow-[inset_3px_0_0_var(--red)]",
                        )}
                      >
                        <td className="w-10 px-2 text-right align-top text-[var(--text-muted)] tabular-nums select-none">{l.n}</td>
                        <td className="px-2 align-top whitespace-pre-wrap [overflow-wrap:anywhere] text-[var(--ink)]">
                          <span className={cn("mr-1.5 select-none", l.kind === "add" ? "text-[var(--green)]" : l.kind === "del" ? "text-[var(--red)]" : "text-transparent")}>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* How far, and on. */}
      <footer className="flex min-w-0 items-center gap-1.5 border-t border-[var(--border)] px-3.5 py-2.5">
        <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
          {seen.size} of {steps.length} read
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-7 text-[12px] text-[var(--ink-2)]" onClick={() => openOutside(`${pr.url}/files`)}>
          <ExternalLinkIcon /> On GitHub
        </Button>
        <Button variant="outline" size="sm" className="h-7 border-[var(--border)] bg-[var(--bg)] text-[12px] shadow-none" disabled={at === 0} onClick={() => go(at - 1)}>
          <ChevronLeftIcon /> Back
        </Button>
        {last ? (
          <Button size="sm" className="h-7 text-[12px]" onClick={onClose}>
            <CheckIcon /> Done
          </Button>
        ) : (
          <Button size="sm" className="h-7 text-[12px]" onClick={() => go(at + 1)}>
            Next <ChevronRightIcon />
          </Button>
        )}
      </footer>
    </section>
  );
}
