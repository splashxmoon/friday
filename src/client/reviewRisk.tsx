import type { ReactNode } from "react";
import type { Risk } from "../review-risk.js";
import type { Identity } from "./storage.js";
import { hostApi } from "./local.js";
import { machineError } from "./GitHubConnect.js";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/**
 * The risk score's pieces on screen, shared by the Agent Board, Code Review: the chip naming the weightiest reason, the
 * "Quick to review" heading over the changes with nothing against them, and approving several of those at once.
 */

const LEVEL_TEXT: Record<Risk["level"], string> = {
  high: "border-[color-mix(in_srgb,var(--red)_40%,var(--border))] text-[var(--red)]",
  medium: "border-[var(--border-strong)] text-[var(--ink-2)]",
  low: "border-[var(--border)] text-[var(--text-muted)]",
};

/** The one reason a change is where it is in the queue; the rest in its tooltip. */
export function RiskChip({ risk, className }: { risk: Risk; className?: string }) {
  const why = risk.reasons.length ? risk.reasons.join(" · ") : risk.top;
  return (
    <Badge
      variant="outline"
      className={cn("h-5 max-w-[190px] min-w-0 shrink rounded-md px-1.5 text-[11px] font-medium", LEVEL_TEXT[risk.level], className)}
      title={`${risk.level === "high" ? "High risk" : risk.level === "medium" ? "Some risk" : "Low risk"}: ${why}`}
      aria-label={`${risk.level} risk: ${risk.top}`}
      data-risk={risk.level}
    >
      <span className="truncate">{risk.top}</span>
    </Badge>
  );
}

/** The heading over the low-risk changes, with what clears them together beside it. */
export function QuickHeader({ n, children }: { n: number; children?: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-1.5 px-2 pt-1 text-[11px] font-medium tracking-[0.06em] text-[var(--text-muted)] uppercase" title="Small changes with nothing sensitive, failing or found by the reviewer">
      <span>Quick to review</span>
      <span className="tabular-nums">{n}</span>
      {children && <span className="ml-auto flex items-center normal-case tracking-normal">{children}</span>}
    </div>
  );
}

export type Approvable = { url: string; title: string; head?: string; id?: string };

/**
 * Approve each on GitHub as this person, through their own computer, one after another. Throws, saying which and why,
 * when any could not be approved, so the dialog asking shows it; the ones that worked stay approved.
 */
export async function approveTogether(identity: Identity, prs: Approvable[]): Promise<number> {
  const failed: string[] = [];
  let ok = 0;
  for (const pr of prs) {
    try {
      await hostApi(identity, "/api/runner/pr.act", { method: "POST", body: JSON.stringify({ url: pr.url, action: "approve", head: pr.head, id: pr.id }) });
      ok++;
    } catch (e) {
      failed.push(`“${pr.title}”: ${machineError(e)}`);
    }
  }
  if (failed.length) throw new Error(`${ok ? `Approved ${ok}. ` : ""}Couldn't approve ${failed.join("; ")}`);
  return ok;
}
