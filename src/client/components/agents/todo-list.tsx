"use client";
// beui.dev/components/agents/todo-list

import { ChevronDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ActionSwapRollText } from "@/components/motion/action-swap-roll";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import {
  EASE_OUT,
  SPRING_LAYOUT,
  SPRING_SWAP,
} from "@/lib/ease";
import { cn } from "@/lib/utils";
import { TaskMark } from "../../TaskMark.js";

export type TodoItemStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "cancelled";

export interface TodoItem {
  id: string;
  title: ReactNode;
  status?: TodoItemStatus;
  progress?: number;
  detail?: ReactNode;
  // Friday's additions (Team tasks), all optional, so the registry's own use is unchanged.
  /** A second line under the title: who has it and where it stands. */
  meta?: ReactNode;
  /** The whole of it on hover, when the title is cut short. */
  tooltip?: string;
  /** Pressing the row. */
  onSelect?: () => void;
  /** Controls at the row's end, pressed without pressing the row. */
  actions?: ReactNode;
}

export interface TodoListProps {
  items: TodoItem[];
  title?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  collapseOnComplete?: boolean;
  maxHeight?: number;
  className?: string;
  /** In place of the list mark until everything is done. */
  icon?: ReactNode;
  /** Under the list, inside it: actions over all of it. */
  footer?: ReactNode;
}

function statusLabel(status: TodoItemStatus) {
  if (status === "in-progress") return "In progress";
  if (status === "completed") return "Completed";
  if (status === "cancelled") return "Cancelled";
  return "Pending";
}

/**
 * How far along the list is, as a ring that fills as its tasks are finished (Arun, 2026-10-23: "add a ring that progressively
 * gets filled as the tasks are getting finished"), in place of a mark that said nothing about it.
 */
/** The Agents panel's ring's stroke (LimitRing's 7 of 64, at this size), so the two are the same thing at a glance. */
const RING_STROKE = 2.6;

function ProgressRing({ done }: { done: number }) {
  const reduce = useReducedMotion() ?? false;
  return (
    <svg viewBox="0 0 24 24" className="size-5 -rotate-90 overflow-visible">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={RING_STROKE} strokeOpacity={0.28} className="text-muted-foreground" />
      <motion.circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE}
        strokeLinecap="round"
        className="text-[color:var(--lvl-ok)]"
        initial={false}
        animate={{ pathLength: Math.max(0, Math.min(1, done)), opacity: done > 0 ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { duration: 0.45, ease: EASE_OUT }}
      />
    </svg>
  );
}

function TodoHeaderIcon({ complete, icon, done }: { complete: boolean; icon?: ReactNode; done: number }) {
  const reduce = useReducedMotion() ?? false;

  return (
    <span
      aria-hidden="true"
      className="relative grid size-6 shrink-0 place-items-center"
    >
      <AnimatePresence initial={false} mode="popLayout">
        {complete ? (
          <motion.svg
            key="complete"
            viewBox="0 0 24 24"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.72 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute size-5.5 overflow-visible text-emerald-500"
          >
            <circle cx="12" cy="12" r="9" fill="currentColor" />
            <motion.path
              d="M7.5 12.25 10.5 15.25 16.75 8.75"
              fill="none"
              stroke="white"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={
                reduce ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }
              }
            />
          </motion.svg>
        ) : (
          <motion.span
            key="todo"
            initial={reduce ? { opacity: 1 } : { opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.72 }}
            transition={reduce ? { duration: 0 } : SPRING_SWAP}
            className="absolute grid place-items-center text-muted-foreground"
          >
            {icon ?? <ProgressRing done={done} />}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/** Each task's mark, as the agents' task board draws it (TaskMark). */
function TodoStatusIcon({ status }: { status: TodoItemStatus }) {
  return (
    <span aria-hidden="true" className="mx-0.5 grid size-5 shrink-0 place-items-center text-muted-foreground">
      <TaskMark state={status === "completed" ? "done" : status === "in-progress" ? "working" : "open"} />
    </span>
  );
}

export function TodoList({
  items,
  title = "To-dos",
  open,
  defaultOpen = true,
  onOpenChange,
  collapseOnComplete = true,
  maxHeight = 248,
  className,
  icon,
  footer,
}: TodoListProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const triggerId = `${baseId}-trigger`;
  const contentId = `${baseId}-content`;
  const viewportRef = useRef<HTMLDivElement>(null);
  const previousComplete = useRef(false);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = open ?? internalOpen;
  const completed = items.filter((item) => item.status === "completed").length;
  const allComplete = items.length > 0 && completed === items.length;
  const itemCount = items.length;

  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );

  useEffect(() => {
    if (previousComplete.current && !allComplete) {
      setOpen(true);
    }
    if (!previousComplete.current && allComplete && collapseOnComplete) {
      setOpen(false);
    }
    previousComplete.current = allComplete;
  }, [allComplete, collapseOnComplete, setOpen]);

  // Opened at its top, where the list starts (Arun, 2026-10-23: "make sure on pop up it loads at the top not the bottom"). It
  // scrolled to its last task each time one was added, so it opened on the end of a long list.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && currentOpen) viewport.scrollTop = 0;
  }, [currentOpen]);

  return (
    <section
      aria-label="Agent task list"
      data-open={currentOpen ? "true" : "false"}
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border/70",
        className,
      )}
    >
      <button
        id={triggerId}
        type="button"
        aria-expanded={currentOpen}
        aria-controls={contentId}
        onClick={() => setOpen(!currentOpen)}
        className="group flex h-11 w-full items-center gap-2.5 rounded-2xl px-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <TodoHeaderIcon complete={allComplete} icon={icon} done={items.length ? completed / items.length : 0} />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground/90">
          {title}
        </h2>
        <span
          className={cn(
            "shrink-0 text-xs font-medium tabular-nums text-muted-foreground",
            allComplete && "text-emerald-600 dark:text-emerald-400",
          )}
        >
          <span className="sr-only">
            {completed} of {items.length} tasks completed
          </span>
          <span aria-hidden="true" className="inline-flex">
            <ActionSwapRollText value={String(completed)}>
              {completed}
            </ActionSwapRollText>
            <span>/</span>
            <span>{items.length}</span>
          </span>
        </span>
        <motion.span
          aria-hidden="true"
          animate={{ rotate: currentOpen ? 180 : 0 }}
          transition={reduce ? { duration: 0 } : SPRING_SWAP}
          className="text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        >
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>

      <AgentDisclosure
        id={contentId}
        role="region"
        aria-labelledby={triggerId}
        open={currentOpen}
      >
        <div
          ref={viewportRef}
          className="scrollbar-hide overflow-y-auto px-2 pb-2"
          style={{ maxHeight }}
        >
          {items.length ? (
            <ol className="space-y-0">
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item) => {
                const status = item.status ?? "pending";
                return (
                  <motion.li
                    layout="position"
                    key={item.id}
                    initial={reduce ? { opacity: 1 } : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={
                      reduce
                        ? { duration: 0 }
                        : {
                            opacity: { duration: 0.18, ease: EASE_OUT },
                            y: SPRING_LAYOUT,
                            layout: SPRING_LAYOUT,
                          }
                    }
                    className={cn(
                      "flex min-h-9 items-center gap-2.5 rounded-xl px-1.5 py-1",
                      item.onSelect && "cursor-pointer outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                    {...(item.onSelect
                      ? {
                          role: "button",
                          tabIndex: 0,
                          onClick: item.onSelect,
                          onKeyDown: (e: KeyboardEvent) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            item.onSelect!();
                          },
                        }
                      : {})}
                  >
                    <TodoStatusIcon status={status} />
                    <span className="sr-only">{statusLabel(status)}: </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className={cn(
                        "min-w-0 truncate text-sm leading-5",
                        status === "pending" && "text-muted-foreground/65",
                        status === "in-progress" && "text-foreground",
                        status === "completed" && "text-muted-foreground/60",
                        status === "cancelled" && "text-muted-foreground/55",
                      )}
                    >
                      {/* Cut short with an ellipsis of its own: an inline block isn't cut by its line's, so a long title was clipped
                          mid-letter (2026-10-27 audit). */}
                      <span className="relative inline-block max-w-full truncate align-bottom">
                        {item.title}
                        <motion.span
                          aria-hidden="true"
                          initial={false}
                          animate={{
                            scaleX: status === "completed" ? 1 : 0,
                            opacity: status === "completed" ? 1 : 0,
                          }}
                          transition={
                            reduce
                              ? { duration: 0 }
                              : { duration: 0.28, ease: EASE_OUT, delay: 0.06 }
                          }
                          className="absolute inset-x-0 top-1/2 h-px origin-left bg-current"
                        />
                      </span>
                    </span>
                    {item.meta ? (
                      <span className="flex min-w-0 items-center gap-1.5 truncate text-xs leading-4 text-muted-foreground/70">
                        {item.meta}
                      </span>
                    ) : null}
                    </span>
                    {item.detail ? (
                      <span className="shrink-0 text-sm text-muted-foreground/55">
                        {item.detail}
                      </span>
                    ) : null}
                    {item.actions ? (
                      <span
                        className="shrink-0"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {item.actions}
                      </span>
                    ) : null}
                  </motion.li>
                );
              })}
            </AnimatePresence>
            </ol>
          ) : (
            <p className="px-1.5 py-2 text-sm text-muted-foreground">
              No tasks yet
            </p>
          )}
          {footer}
        </div>
      </AgentDisclosure>
    </section>
  );
}
