import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Small Dass pieces shared by the Agent Board, Code Review and the agent builder (docs/dass-design-language.md): the page's
 * tabs, the state dot with every state a page draws, a count, and a tooltip that names its shortcut.
 */

/** What a dot says: alive (teal), waiting on you (amber), broken (red), done (solid ink), or quiet (hollow). */
export type DotState = "working" | "needs" | "bad" | "done" | "idle";

export function Dot({ state, className, title }: { state: DotState; className?: string; title?: string }) {
  return (
    <span
      aria-hidden={title ? undefined : true}
      title={title}
      className={cn("dass-dot", className)}
      data-state={state}
    />
  );
}

/** A number beside a label: quiet, tabular, never coloured unless it waits on you. */
export function Count({ n, needs, className }: { n: number | string; needs?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1.5 text-[11px] font-medium tabular-nums text-[color:var(--text-muted)]",
        // Waiting on you: a soft amber tint with the number in amber, in light and dark alike (Arun, 2026-10-20).
        needs ? "bg-[color-mix(in_srgb,var(--dass-needs)_16%,transparent)] font-semibold text-[color:var(--dass-needs)]" : "bg-[color-mix(in_srgb,var(--ink)_7%,transparent)]",
        className,
      )}
    >
      {n}
    </span>
  );
}

/** A tooltip with the shortcut beside what it does, as the sidebar's. */
export function Tip({ label, keys, children, side = "bottom" }: { label: ReactNode; keys?: string; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {keys && <span className="dass-kbd ml-2">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** One page's views, as shadcn's tabs on a muted track: the chosen one lifted. Only the list; the page draws what is shown. */
export function PageTabs<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: ReactNode; /** Said in the tooltip, with the shortcut. */ tip?: string; keys?: string }[];
  label: string;
  className?: string;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)} className={cn("gap-0", className)}>
      {/* Never wider than its column: on a phone the last tab ran off the screen ("Only Run now", 2026-10-27 audit); it scrolls. */}
      <TabsList aria-label={label} className="h-8 group-data-[orientation=horizontal]/tabs:h-8 max-w-full justify-start gap-0.5 overflow-x-auto rounded-lg bg-[var(--hover)] p-[3px] [scrollbar-width:none]">
        {options.map((o) => {
          const trigger = (
            <TabsTrigger
              key={o.value}
              value={o.value}
              className="h-[26px] flex-none gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-[var(--text-muted)] shadow-none transition-colors duration-[var(--dass-fast)] hover:text-[var(--ink)] aria-selected:border-transparent aria-selected:bg-[var(--bg)] aria-selected:text-[var(--ink)] aria-selected:shadow-[0_1px_3px_rgb(0_0_0/.12),0_0_0_1px_var(--border)] dark:aria-selected:border-transparent dark:aria-selected:bg-[var(--bg)]"
            >
              {o.label}
            </TabsTrigger>
          );
          // The tooltip sets its own data-state on the trigger, so the chosen tab is styled by aria-selected, not data-state.
          return o.keys ? (
            <Tip key={o.value} label={o.tip ?? (typeof o.label === "string" ? o.label : "Show this")} keys={o.keys}>
              {trigger}
            </Tip>
          ) : (
            trigger
          );
        })}
      </TabsList>
    </Tabs>
  );
}
