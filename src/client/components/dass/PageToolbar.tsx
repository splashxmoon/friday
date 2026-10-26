import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A page's one row of controls, laid out the same on every page (Arun, 2026-10-20: "all of the buttons for all of the pages
 * consistently placed in the same place like the right side"): finding things on the left (search, filters), and on the right,
 * ending at the page's right edge, which view (tabs) and what to do, the main action last. Every control in it is 32px tall.
 */
export function PageToolbar({ left, children, className }: { left?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("dass-toolbar flex min-h-8 flex-wrap items-center gap-2", className)}>
      {left && <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{left}</div>}
      {children && <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</div>}
    </div>
  );
}
