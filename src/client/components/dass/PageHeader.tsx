import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * A page's head, shared by every Dass page. A page (h1): its title for screen readers only and its controls on the right. A
 * section (h2, Settings): a 26px title, a muted line under it, and its actions on the right.
 */
export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  as: H = "h1",
  titleRef,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A quiet word above the title: where this is (a settings group). */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  as?: "h1" | "h2";
  titleRef?: Ref<HTMLHeadingElement>;
  className?: string;
}) {
  // A page's own title and line under it are gone from sight (Arun, 2026-10-19: "get rid of all of these header text"): the
  // sidebar already says where you are. The title stays for screen readers; the page's controls keep the row, on the right.
  // A section's heading (as="h2", Settings) is still shown.
  if (H === "h1")
    return (
      <header className={cn(actions ? "mb-5 flex flex-wrap items-center justify-end gap-2" : "contents", className)}>
        <h1 ref={titleRef} tabIndex={titleRef ? -1 : undefined} className="sr-only">
          {title}
        </h1>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </header>
    );
  return (
    <header className={cn("mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[12px] font-medium text-[var(--text-muted)]">{eyebrow}</div>}
        <H ref={titleRef} tabIndex={titleRef ? -1 : undefined} className="m-0 text-[26px] leading-[1.15] font-semibold tracking-[-0.025em] text-[var(--ink)] outline-none">
          {title}
        </H>
        {subtitle && <p className="mt-1.5 mb-0 max-w-[64ch] text-[14px] leading-relaxed text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
