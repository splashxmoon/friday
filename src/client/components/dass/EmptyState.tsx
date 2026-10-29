import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The Dass empty state (docs/dass-design-language.md): an icon drawn in meta ink, a title, one or two lines saying what to do
 * next, and at most one action. For a page or a panel with nothing in it yet, or a thing that can't be shown.
 */
export function EmptyState({ icon, title, children, action, tone, className, small }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; /** Amber when it waits on the person, red when something is broken. */ tone?: "needs" | "bad"; className?: string; /** Inside a section of a page, under its 15px heading: a title that doesn't outrank it (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"). */ small?: boolean }) {
  return (
    <div className={cn("mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-12 text-center", className)}>
      {icon && (
        <div
          className={cn(
            // A drawing, not a tile (2026-10-29 direction: cards are for work products only): the icon in meta ink, or in its state.
            "grid place-items-center text-[var(--text-muted)]",
            small ? "[&_svg]:size-5" : "[&_svg]:size-6",
            tone === "needs" && "text-[var(--dass-needs)]",
            tone === "bad" && "text-[var(--red)]",
          )}
        >
          {icon}
        </div>
      )}
      <h2 className={cn("m-0 font-semibold text-[var(--ink)]", small ? "text-[14px] leading-[22px]" : "text-[16px] leading-[22px] tracking-[-0.01em]")}>{title}</h2>
      {children && <div className={cn("text-[var(--text-muted)]", small ? "text-[13px] leading-[18px]" : "text-[14px] leading-[22px]")}>{children}</div>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
