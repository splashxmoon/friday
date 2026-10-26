"use client";

import styles from "./TodoList.module.css";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type TodoStatus = "pending" | "active" | "completed" | "cancelled";

export interface TodoStep {
  id: string;
  title: string;
  status: TodoStatus;
  /** Who has it: an agent's mark and name, at the row's end. */
  who?: ReactNode;
  /** Where it stands, in a word or two beside who has it: "In review", "Waiting on Tests". */
  note?: string;
  /** How that reads: amber for something to look at, red for stuck. */
  tone?: "warn" | "bad";
  /** The whole of it, for the tooltip, when the title is cut short. */
  detail?: string;
  /** Pressing the row: to where it was handed over. */
  onSelect?: () => void;
  /** Controls at the row's end (the team's task menu), pressed without pressing the row. */
  actions?: ReactNode;
}

const cls = (base: string, on?: boolean) => base + (on ? " " + styles.on : "");
const CheckIcon = ({ on }: { on?: boolean }) => (
  <svg className={cls(styles.todoIcon, on)} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ArrowIcon = ({ on }: { on?: boolean }) => (
  <svg className={cls(styles.todoIcon + " " + styles.strong, on)} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="m12.75 15 3-3m0 0-3-3m3 3h-7.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const DashedIcon = ({ on }: { on?: boolean }) => (
  <svg className={cls(styles.todoIcon, on)} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="1.8 3.6" strokeLinecap="round" />
  </svg>
);

// one character slot that rolls the old glyph up and the new one in on change
const RollDigit = ({ char }: { char: string }) => {
  const prev = useRef(char);
  const [roll, setRoll] = useState<{ from: string; to: string } | null>(null);
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (char === prev.current) return;
    const from = prev.current;
    prev.current = char;
    setRoll({ from, to: char });
    setUp(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setUp(true)));
    const done = setTimeout(() => setRoll(null), 380);
    return () => { cancelAnimationFrame(raf); clearTimeout(done); };
  }, [char]);
  if (!roll) return <span className={styles.rollDigit}>{char}</span>;
  return (
    <span className={styles.rollDigit}>
      <span className={cls(styles.rollInner, up)}>
        <span>{roll.from}</span>
        <span>{roll.to}</span>
      </span>
    </span>
  );
};
const RollingCount = ({ value }: { value: string }) => (
  <span className={styles.rollCount} aria-label={value}>
    {value.split("").map((c, i) => <RollDigit key={i} char={c} />)}
  </span>
);
const FilledCheckIcon = () => (
  <svg className={styles.todoHeadCheck} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z" fill="currentColor" />
  </svg>
);

export function TodoList({ steps, title = "To-dos", defaultCollapsed = false, icon, footer }: { steps: TodoStep[]; title?: string; defaultCollapsed?: boolean; /** In place of the list mark while nothing has started. */ icon?: ReactNode; /** Under the list, inside it: actions over all of it (Team tasks' "N stuck"). */ footer?: ReactNode }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Follows when what it should be changes: the team's list opens when new work arrives and folds once it is all done. A
  // press in between is kept until then.
  const was = useRef(defaultCollapsed);
  useEffect(() => {
    if (was.current === defaultCollapsed) return;
    was.current = defaultCollapsed;
    setCollapsed(defaultCollapsed);
  }, [defaultCollapsed]);
  // Counted so each opening starts the items in again, one after another.
  const [opens, setOpens] = useState(0);
  const n = steps.length;
  const done = steps.filter((t) => t.status === "completed").length;
  const allDone = n > 0 && done === n;
  const running = !allDone && steps.some((t) => t.status === "active" || t.status === "completed");
  const pct = n ? Math.round((done / n) * 100) : 0;

  return (
    <div className={styles.todo} data-collapsed={collapsed ? "true" : "false"} data-done={allDone ? "true" : undefined}>
      <button
        type="button"
        className={styles.todoHead}
        aria-expanded={!collapsed}
        aria-label="Toggle to-dos"
        onClick={() => {
          if (collapsed) setOpens((o) => o + 1);
          setCollapsed(!collapsed);
        }}
      >
        <span className={styles.todoHeadIcon}>
          {allDone ? (
            <FilledCheckIcon />
          ) : running ? (
            <span className={styles.todoHeadPie} style={{ ["--todo-pie" as string]: pct + "%" }} aria-hidden="true">
              <svg className={styles.todoHeadPieRing} viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeDasharray="2.2 4.4" strokeLinecap="round" />
              </svg>
            </span>
          ) : icon ? (
            <span className={styles.todoListIcon}>{icon}</span>
          ) : (
            <svg className={styles.todoListIcon} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 5h8" />
              <path d="M13 12h8" />
              <path d="M13 19h8" />
              <path d="m3 17 2 2 4-4" />
              <path d="m3 7 2 2 4-4" />
            </svg>
          )}
          <svg className={styles.todoChevron} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="m19.5 8.25-7.5 7.5-7.5-7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className={styles.todoTitle}>{title}</span>
        <span className={styles.todoCount}>
          <RollingCount value={done + "/" + n} />
        </span>
      </button>

      <div className={styles.todoCollapsible + (collapsed ? " " + styles.isCollapsed : "")}>
        <div className={styles.todoInner}>
          <ul key={opens} className={styles.todoList}>
            {steps.map((t, i) => {
              const isDone = t.status === "completed";
              const active = t.status === "active";
              return (
                <li
                  key={t.id}
                  className={styles.todoItem + (isDone ? " " + styles.done : active ? " " + styles.active : t.status === "cancelled" ? " " + styles.cancelled : "") + (t.onSelect ? " " + styles.pressable : "")}
                  style={{ ["--i" as string]: i }}
                  {...(t.detail ? { title: t.detail } : {})}
                  {...(t.onSelect ? { role: "button", tabIndex: 0, onClick: t.onSelect, onKeyDown: (e: React.KeyboardEvent) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), t.onSelect!()) } : {})}
                >
                  <span className={styles.todoIconWrap}>
                    <DashedIcon on={!isDone && !active} />
                    <ArrowIcon on={active} />
                    <CheckIcon on={isDone} />
                  </span>
                  {t.who || t.note ? (
                    // Who has it and where it stands on a line of their own under the title, so the title keeps the row.
                    <span className={styles.todoText}>
                      <span className={styles.todoLabel} data-label={t.title}>{t.title}</span>
                      <span className={styles.todoMeta}>
                        {t.who && <span className={styles.todoWho}>{t.who}</span>}
                        {t.who && t.note && <span className={styles.todoSep} aria-hidden="true">·</span>}
                        {t.note && <span className={styles.todoNote + (t.tone ? " " + styles[t.tone] : "")}>{t.note}</span>}
                      </span>
                    </span>
                  ) : (
                    <span className={styles.todoLabel} data-label={t.title}>{t.title}</span>
                  )}
                  {t.actions && (
                    <span className={styles.todoActions} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                      {t.actions}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {footer}
        </div>
      </div>
    </div>
  );
}
