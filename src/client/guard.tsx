import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import { reloadForChunk } from "./BuildWatch.js";
import { EmptyState } from "./components/dass/EmptyState.js";
import "./guard.css";

/**
 * What every guard says in the console as it catches something, so a report (or the e2e suite, which fails on console errors and
 * expects this one only where a spec breaks something on purpose) can tell a caught piece from a crash.
 */
export const GUARD_TAG = "[friday guard]";

export interface Caught {
  error: Error;
  /** Draw it again, as it is now. */
  retry: () => void;
  /** The error's words and where in the page it was, for a bug report: never what the piece was showing. */
  details: string;
}

interface Props {
  /** What this guard holds, in the console line and the details: "feed row", "preview", "terminal". */
  where: string;
  /** What it is drawing now (an event's seq, a file's path): when this changes, it tries again. */
  reset: unknown;
  children: ReactNode;
  /** How to say it couldn't be drawn here; a quiet line by default (GuardLine). */
  fallback?: (c: Caught) => ReactNode;
}

interface State {
  error: Error | null;
  stack: string;
  at: unknown;
}

/**
 * One piece of the page that fails to draw stays one piece (spec 13, What can break 1; Arun, 2026-11-24: "Go all out and fix
 * these problems"): React leaves the whole window to the crash screen for anything a boundary doesn't catch, so a single bad
 * row of a session took the session, the sidebar and the composer down with it, and Reload drew the same row again. Around
 * each piece that draws what it was given (a feed row, the preview, the terminal, a diff, the editor, an agent's Markdown), this
 * keeps the rest of the window working and says, in that piece's place, that it couldn't be shown, with Try again.
 */
export class Guard extends Component<Props, State> {
  state: State = { error: null, stack: "", at: this.props.reset };

  static getDerivedStateFromError(e: unknown): Partial<State> {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }

  static getDerivedStateFromProps(p: Props, s: State): Partial<State> | null {
    // Its content changed (the row's run went on, another file opened): drawn again, fresh.
    return p.reset !== s.at ? { error: null, stack: "", at: p.reset } : null;
  }

  /** What this one has said in the console already: a piece that fails again as it streams is said once, not per word. */
  private said = new Set<string>();

  componentDidCatch(e: Error, info: ErrorInfo) {
    // A piece of the app a new build no longer has: the page reloads for it, as the root does (BuildWatch.ts).
    if (reloadForChunk(e)) return;
    if (!this.said.has(e.message)) {
      this.said.add(e.message);
      console.error(GUARD_TAG, this.props.where, e, info.componentStack);
    }
    this.setState({ stack: info.componentStack ?? "" });
  }

  retry = () => this.setState({ error: null, stack: "" });

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const caught: Caught = { error, retry: this.retry, details: detailsOf(this.props.where, error, stack) };
    return this.props.fallback ? this.props.fallback(caught) : <GuardLine caught={caught} />;
  }
}

/** The error, where it was and the first lines of both stacks: enough to find it, nothing of what was on screen. */
export function detailsOf(where: string, e: Error, componentStack = ""): string {
  const lines = (s: string, n: number) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(0, n).join("\n");
  return [`Friday couldn't draw a ${where}: ${e.message || e.name || "unknown error"}`, lines(e.stack ?? "", 8), componentStack ? `In:\n${lines(componentStack, 8)}` : ""].filter(Boolean).join("\n\n");
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** A row that couldn't be drawn, as one quiet line in its place: what happened, Try again, and the details to send. */
export function GuardLine({ caught, label = "This step couldn't be shown" }: { caught: Caught; label?: string }) {
  return (
    <div className="guard-line" role="status">
      <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="guard-line-text">{label}</span>
      <span className="guard-line-acts">
        <button type="button" className="btn small ghost" onClick={caught.retry}>
          Try again
        </button>
        <button type="button" className="btn small ghost" onClick={() => copy(caught.details)}>
          Copy details
        </button>
      </span>
    </div>
  );
}

/** A panel that couldn't be drawn (the preview, the terminal, a diff, the editor): said in its place, the way back beside it. */
export function GuardPanel({ caught, title }: { caught: Caught; title: string }) {
  return (
    <div className="guard-panel" role="status">
      <EmptyState
        small
        tone="bad"
        icon={<CircleAlertIcon aria-hidden />}
        title={title}
        action={
          <>
            <button type="button" className="btn small" onClick={caught.retry}>
              Try again
            </button>
            <button type="button" className="btn small ghost" onClick={() => copy(caught.details)}>
              Copy details
            </button>
          </>
        }
      >
        The rest of Friday is fine. Try again, or copy the details to report it.
      </EmptyState>
    </div>
  );
}

/** A panel's guard: the panel, or a word in its place that it couldn't be shown. */
export function PanelGuard({ where, title, reset, children }: { where: string; title: string; reset: unknown; children: ReactNode }) {
  return (
    <Guard where={where} reset={reset} fallback={(c) => <GuardPanel caught={c} title={title} />}>
      {children}
    </Guard>
  );
}
