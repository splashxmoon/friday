import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The Dass empty state (docs/dass-design-language.md): an icon on a quiet tile, a title, one or two lines saying what to do
 * next, and at most one action. For a page or a panel with nothing in it yet, or a thing that can't be shown.
 */
export function EmptyState({ icon, title, children, action, tone, className }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; /** Amber when it waits on the person, red when something is broken. */ tone?: "needs" | "bad"; className?: string }) {
  return (
    <div className={cn("mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center", className)}>
      {icon && (
        <div
          className={cn(
            "grid size-12 place-items-center rounded-xl border border-[var(--border)] bg-[var(--card)] text-[var(--text-muted)] shadow-xs [&_svg]:size-5",
            tone === "needs" && "border-transparent bg-[color-mix(in_srgb,var(--dass-needs)_14%,transparent)] text-[var(--dass-needs)]",
            tone === "bad" && "border-transparent bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-[var(--red)]",
          )}
        >
          {icon}
        </div>
      )}
      <h2 className="m-0 text-[17px] font-semibold tracking-tight text-[var(--ink)]">{title}</h2>
      {children && <div className="text-[13.5px] leading-relaxed text-[var(--text-muted)]">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
