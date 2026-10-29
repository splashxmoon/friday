import { useState, type FormEvent, type ReactNode } from "react";
import { CheckIcon, CircleAlertIcon, InfoIcon, MoreHorizontalIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "../icons.js";
import type { MenuItem } from "../ui.js";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * The pieces every Dass page is made of (docs/dass-design-language.md), on top of shadcn's: one page header, one empty
 * state, and the settings shape (a titled group of rows, each a label, a hint and its control), so Settings, Usage, Skills,
 * People and Connections read as one app.
 */

// One page header and one empty state for every page, shared with the other Dass pages (components/dass/).
export { PageHeader } from "./dass/PageHeader";
export { EmptyState } from "./dass/EmptyState";
export { PageToolbar } from "./dass/PageToolbar";

/** A surface: a tray, one step off the page (--tray in style.css, the tray pass), 16px corners. */
export const surface = "tray rounded-xl border border-[var(--border)] bg-[var(--raised)] shadow-[var(--shadow-xs),var(--edge)]";

/** A titled group of settings rows, as one card. */
export function SettingsGroup({
  title,
  hint,
  action,
  children,
  className,
  tone,
}: {
  title?: ReactNode;
  /** Beside the title: usually a <Hint>. */
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** "danger": for what can't be taken back, outlined in red. */
  tone?: "danger";
}) {
  return (
    // A tray: its title and action on the tray, its rows on a panel inset in it (Arun, 2026-10-27, a reference to build the app's
    // components on). Untitled, the rows' panel is the whole of it.
    <section className={cn("tray tray-group flex flex-col", !title && "tray-bare", tone === "danger" && "tray-danger", className)}>
      {title && (
        <div className="tray-head">
          <h3 className={cn("m-0 text-[13px] font-semibold text-[var(--ink)]", tone === "danger" && "text-[var(--red)]")}>{title}</h3>
          {hint}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </div>
      )}
      <div className="tray-in divide-y divide-[var(--border)] px-4">{children}</div>
    </section>
  );
}

/** One setting: its name and a line on what it does, and its control on the right. A form when it saves on Enter. */
export function SettingsRow({
  label,
  hint,
  children,
  htmlFor,
  onSubmit,
  className,
  stack,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  htmlFor?: string;
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  className?: string;
  /** The control under the text rather than beside it, for a wide one (a link, a list). */
  stack?: boolean;
}) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-medium text-[var(--ink)]">
            {label}
          </label>
        ) : (
          <div className="text-[13px] font-medium text-[var(--ink)]">{label}</div>
        )}
        {hint && <div className="mt-0.5 max-w-[72ch] text-[13px] leading-snug text-[var(--text-muted)]">{hint}</div>}
      </div>
      {children && <div className={cn("flex min-w-0 items-center gap-2", stack ? "w-full flex-col items-stretch" : "shrink-0 flex-wrap justify-end")}>{children}</div>}
    </>
  );
  const cls = cn("flex gap-x-6 gap-y-2.5 py-3.5", stack ? "flex-col" : "items-center justify-between max-sm:flex-col max-sm:items-stretch", className);
  return onSubmit ? (
    <form
      className={cls}
      data-set-row=""
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(e);
      }}
    >
      {body}
    </form>
  ) : (
    <div className={cls} data-set-row="">
      {body}
    </div>
  );
}

/** A short list of facts under a group: a term and what it means, as quiet rows. */
export function Facts({ items, className }: { items: { term: ReactNode; detail: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn("m-0 grid gap-x-6 gap-y-2.5 sm:grid-cols-[150px_1fr]", className)}>
      {items.map((f, i) => (
        <div key={i} className="contents">
          <dt className="text-[13px] font-medium text-[var(--ink-2)]">{f.term}</dt>
          <dd className="m-0 text-[13px] leading-snug text-[var(--text-muted)]">{f.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One of a few, side by side: shadcn's toggle group as a segmented track. Never empty: pressing the chosen one keeps it. */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (v: T) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      disabled={disabled}
      aria-label={label}
      onValueChange={(v) => v && onChange(v as T)}
      // A plain segmented control (2026-10-29 direction §9.2): a hairline track, nothing filled but the one chosen.
      className={cn("h-8 gap-0.5 rounded-[8px] border border-[var(--border)] bg-transparent p-[2px]", className)}
    >
      {options.map(([v, text]) => (
        <ToggleGroupItem
          key={v}
          value={v}
          className="h-[26px] min-w-0 rounded-[6px] px-2.5 text-[13px] font-medium text-[var(--text-muted)] transition-colors duration-[var(--dass-fast)] hover:bg-transparent hover:text-[var(--ink)] data-[state=on]:bg-[var(--hover-strong)] data-[state=on]:text-[var(--ink)] data-[state=on]:shadow-none"
        >
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * A small state word. Monochrome by default; "live" is teal (something running now), "needs" amber (waiting on the person),
 * "danger" red (broken). Nothing else is coloured.
 */
export function StateBadge({ tone, children, className, title }: { tone?: "live" | "needs" | "danger"; children: ReactNode; className?: string; title?: string }) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "h-5 rounded-md border-[var(--border)] px-1.5 text-[12px] font-medium text-[var(--ink-2)]",
        tone === "live" && "border-transparent bg-[color-mix(in_srgb,var(--dass-live)_14%,transparent)] text-[var(--dass-live)]",
        tone === "needs" && "border-transparent bg-[color-mix(in_srgb,var(--dass-needs)_16%,transparent)] text-[var(--dass-needs)]",
        tone === "danger" && "border-transparent bg-[color-mix(in_srgb,var(--red)_14%,transparent)] text-[var(--red)]",
        className,
      )}
    >
      {children}
    </Badge>
  );
}

/** A line said after an action: quiet when it went well, red when it didn't. Empty, it takes no room (but stays announced). */
export function Note({ ok = true, children, className }: { ok?: boolean; children?: ReactNode; className?: string }) {
  return (
    <p role={ok ? "status" : "alert"} className={cn("set-note m-0 text-[13px]", ok ? "text-[var(--text-muted)]" : "text-[var(--red)]", className)}>
      {children}
    </p>
  );
}

/** The button classes for a destructive action that is still one press away from happening (an outline, red words). */
export const dangerOutline = "text-[var(--red)] hover:text-[var(--red)] hover:bg-[color-mix(in_srgb,var(--red)_8%,transparent)]";

/** A section of a page: its title (and how many), a line on what it holds, and its own control on the right. */
export function SectionHeader({
  title,
  count,
  description,
  action,
  className,
}: {
  title: ReactNode;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <h2 className="m-0 flex items-baseline gap-2 text-[15px] font-semibold tracking-[-0.01em] text-[var(--ink)]">
          {title}
          {count !== undefined && <span className="text-[13px] font-normal tabular-nums text-[var(--text-muted)]">{count}</span>}
        </h2>
        {description && <p className="mt-0.5 mb-0 text-[13px] leading-snug text-[var(--text-muted)]">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/** One figure, large, with what it is above it and a quiet line under it. */
export function StatTile({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn(surface, "flex min-w-0 flex-col gap-1 px-4 py-3.5", className)}>
      <span className="text-[12px] font-medium text-[var(--text-muted)]">{label}</span>
      <span className="text-[24px] leading-tight font-semibold tracking-[-0.02em] tabular-nums text-[var(--ink)]">{value}</span>
      {sub && <span className="text-[12px] leading-snug text-[var(--text-muted)]">{sub}</span>}
    </div>
  );
}

/**
 * A line the page wants read: quiet by default; amber when it waits on the person, red when something failed. One action, or
 * a dismiss, may sit at its end.
 */
export function Callout({
  tone,
  icon,
  action,
  onDismiss,
  children,
  role = "status",
  className,
}: {
  tone?: "needs" | "danger";
  icon?: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  children: ReactNode;
  role?: "status" | "alert";
  className?: string;
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3.5 py-2.5 text-[13px] leading-normal text-[var(--ink-2)] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--text-muted)]",
        tone === "needs" && "border-[color-mix(in_srgb,var(--dass-needs)_35%,transparent)] bg-[color-mix(in_srgb,var(--dass-needs)_9%,transparent)] [&>svg]:text-[var(--dass-needs)]",
        tone === "danger" && "border-[color-mix(in_srgb,var(--red)_35%,transparent)] bg-[color-mix(in_srgb,var(--red)_8%,transparent)] [&>svg]:text-[var(--red)]",
        className,
      )}
    >
      {icon ?? (tone === "danger" ? <CircleAlertIcon /> : <InfoIcon />)}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
      {onDismiss && (
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={onDismiss}>
          <XIcon />
        </Button>
      )}
    </div>
  );
}

/**
 * The app's menus (a list of MenuItem, as MenuButton takes) drawn as shadcn's dropdown menu. The list is made when the menu
 * opens, so it says what is true then. `trigger` is the button; without one, a quiet "⋯".
 */
export function ActionMenu({ items, label, trigger, align = "end" }: { items: () => MenuItem[]; label: string; trigger?: ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const list = open ? (items().filter(Boolean) as Exclude<MenuItem, false | null | undefined>[]) : [];
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild aria-label={label}>
            {trigger ?? (
              <Button variant="ghost" size="icon-sm" aria-label={label} className="text-[var(--text-muted)] data-[state=open]:bg-[var(--hover)]">
                <MoreHorizontalIcon />
              </Button>
            )}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align={align} className="min-w-52">
        {list.map((it, i) =>
          "heading" in it ? (
            it.heading ? (
              <DropdownMenuLabel key={i} className="text-[12px] font-medium text-[var(--text-muted)]">
                {it.heading}
              </DropdownMenuLabel>
            ) : (
              <DropdownMenuSeparator key={i} />
            )
          ) : "label" in it ? (
            <DropdownMenuItem key={i} variant={it.danger ? "destructive" : "default"} disabled={it.disabled} title={it.title} onSelect={() => it.onSelect()} className="text-[13px]">
              {it.mark ?? (it.checked ? <CheckIcon /> : it.icon ? <Icon name={it.icon} size={14} /> : null)}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{it.label}</span>
                {it.sub && <span className="text-[12px] text-[var(--text-muted)]">{it.sub}</span>}
              </span>
              {it.hint && <span className="ml-3 max-w-40 truncate font-mono text-[12px] text-[var(--text-muted)]">{it.hint}</span>}
            </DropdownMenuItem>
          ) : null,
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A dialog that is a form: a title and a line under it, the fields, and its actions at the foot. Escape or the dim closes it. */
export function FormDialog({
  title,
  sub,
  onClose,
  onSubmit,
  children,
  actions,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
  actions: ReactNode;
  className?: string;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className={cn("max-h-[min(860px,calc(100vh-48px))] overflow-y-auto sm:max-w-[560px]", className)}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-[18px]">{title}</DialogTitle>
            {sub && <DialogDescription className="text-[13px]">{sub}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter className="pt-1">{actions}</DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A labelled field: its name, the control, and a line under it (red when it says what is wrong). */
export function Field({ label, htmlFor, hint, bad, children, className }: { label: ReactNode; htmlFor?: string; hint?: ReactNode; bad?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--ink)]">
        {label}
      </Label>
      {children}
      {hint && <span className={cn("text-[12px] leading-snug text-[var(--text-muted)]", bad && "text-[var(--red)]")}>{hint}</span>}
    </div>
  );
}
