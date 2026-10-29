import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { hostApi } from "./local.js";
import { openOutside } from "./openOutside.js";
import type { Identity } from "./storage.js";
import { ConfirmDialog, Skeleton, type Confirmation } from "./ui.js";

/**
 * Connecting this computer to GitHub, from wherever GitHub is needed.
 *
 * There is no Connections page to send people to any more, and Solo is mostly people whose only GitHub login is the one
 * in their browser. So the button is here: press it, a code is copied and github.com opens, type the code, approve, done.
 * The login lands where git keeps its own (see runner/github.ts), so it works for every repo picker, clone, push and pull
 * request on this computer, and Friday's server never holds it.
 */

export interface GithubStatus {
  connected: boolean;
  login?: string;
  avatar?: string;
  source?: "env" | "gh" | "git" | "friday";
  managed?: boolean;
  ghInstalled: boolean;
  pending?: { userCode: string; uri: string; expiresAt: number };
  error?: string;
}

/** A computer on an older desktop app doesn't know the newer requests yet; it says so in these words. */
export const outdated = (e: unknown) => /Unknown request/.test(e instanceof Error ? e.message : String(e));
export const OUTDATED = "Update the Friday desktop app to use this: it updates itself when it restarts.";
export const machineError = (e: unknown) => (outdated(e) ? OUTDATED : e instanceof Error ? e.message : String(e));

const SOURCE: Record<NonNullable<GithubStatus["source"]>, string> = {
  env: "from GITHUB_TOKEN",
  gh: "through the GitHub CLI",
  git: "through git's saved login",
  friday: "connected in Friday",
};

export function useGithub(identity: Identity, enabled = true) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState("");
  const read = useCallback(async () => {
    try {
      const s = await hostApi<GithubStatus>(identity, "/api/runner/github.status");
      setStatus(s);
      setError("");
      return s;
    } catch (e) {
      setError(machineError(e));
      return null;
    }
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (enabled) void read();
  }, [enabled, read]);
  // A code is out: look every two seconds for the browser approving it.
  const waiting = !!status?.pending;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void read(), 2000);
    return () => clearInterval(t);
  }, [waiting, read]);
  return { status, error, read, setStatus, setError };
}

/**
 * `empty`: drawn as a page's empty state (a mark, a heading, a line and the buttons, centred), for a page that has nothing to
 * show until GitHub is connected. The same states and buttons as the card.
 */
export function GitHubConnect({ identity, onChange, compact, why, empty, bare }: { identity: Identity; onChange?: () => void; compact?: boolean; why?: string; empty?: boolean; /** Only the buttons (and a pending code or an error): for a place that already heads it "Connect GitHub" itself, like Setup's step (Arun, 2026-10-28: "TEST EVERYTHING… EVERY INTERACTION, EVERY VISUAL"; it showed the heading twice). */ bare?: boolean }) {
  const { status, error, read, setStatus, setError } = useGithub(identity);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  // Told once when a code turns into a login, so the page asking can look again.
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (status?.pending) wasWaiting.current = true;
    else if (wasWaiting.current && status?.connected) {
      wasWaiting.current = false;
      onChange?.();
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const s = await hostApi<GithubStatus>(identity, "/api/runner/github.connect", { method: "POST", body: "{}" });
      setStatus(s);
      if (s.pending) {
        setCopied(false);
        void navigator.clipboard?.writeText(s.pending.userCode).then(() => setCopied(true), () => {});
        openOutside(s.pending.uri);
      }
    } catch (e) {
      setError(machineError(e));
    }
    setBusy(false);
  };
  const cancel = async () => {
    wasWaiting.current = false;
    // A machine that didn't answer leaves the card as it was, with its buttons, rather than a blank until the page is reopened.
    const next = await hostApi<GithubStatus>(identity, "/api/runner/github.cancel", { method: "POST", body: "{}" }).catch(() => null);
    if (next) setStatus(next);
    else setError("The machine didn't answer. Try again.");
  };
  const useCli = async () => {
    try {
      const r = await hostApi<{ opened: boolean; command: string }>(identity, "/api/runner/gh-login", { method: "POST", body: "{}" });
      setError(r.opened ? "Finish signing in in the terminal window, then press Refresh." : `Run this to sign in: ${r.command}`);
    } catch (e) {
      setError(machineError(e));
    }
  };
  const disconnect = () =>
    setConfirm({
      title: "Disconnect GitHub?",
      body: "Friday's GitHub login comes off this computer, for git and gh too. Clones and pushes that used it will ask you to sign in again.",
      action: "Disconnect",
      onConfirm: async () => {
        setStatus(await hostApi<GithubStatus>(identity, "/api/runner/github.disconnect", { method: "POST", body: "{}" }));
        onChange?.();
      },
    });

  const dialog = confirm && <ConfirmDialog confirmation={confirm} onClose={() => setConfirm(null)} />;

  if (!status && !error) {
    return (
      <div className={`gh-connect ${compact ? "compact" : ""}`} aria-busy>
        <Skeleton w="40%" h={13} />
        <Skeleton w="70%" h={11} />
      </div>
    );
  }

  if (status?.connected) {
    return (
      <div className={`gh-connect connected ${compact ? "compact" : ""}`}>
        {status.avatar ? <img className="gh-avatar" src={status.avatar} alt="" /> : <Icon name="user" size={18} />}
        <div className="gh-body">
          <div className="gh-title">GitHub · @{status.login}</div>
          <div className="gh-sub">{status.source ? `Signed in ${SOURCE[status.source]}.` : "Signed in."} Pull requests, repos, clones and pushes on this computer use it.</div>
        </div>
        {status.managed ? (
          <button type="button" className="btn ghost small" onClick={disconnect}>
            Disconnect
          </button>
        ) : (
          <span className="muted small gh-note" title="This login was set up outside Friday, so it's removed the same way">
            {status.source === "gh" ? "Sign out with gh auth logout" : status.source === "git" ? "Managed by git" : ""}
          </span>
        )}
        {dialog}
      </div>
    );
  }

  const pending = status?.pending;
  const failed = (error || status?.error) && (
    <p role="alert" className="error small gh-error">
      {error || status?.error}
    </p>
  );
  const actions = pending ? (
    <>
      <button type="button" className={`btn ghost ${empty ? "" : "small"}`} onClick={() => void cancel()}>
        Cancel
      </button>
      <button type="button" className={`btn primary ${empty ? "" : "small"}`} onClick={() => openOutside(pending.uri)}>
        Open GitHub
      </button>
    </>
  ) : (
    <>
      {status?.ghInstalled && (
        <button type="button" className={`btn ghost ${empty ? "" : "small"}`} onClick={() => void useCli()} title="Sign in with the GitHub CLI in a terminal instead">
          Use gh
        </button>
      )}
      {error && !status ? (
        <button type="button" className={`btn ghost ${empty ? "" : "small"}`} onClick={() => void read()}>
          Try again
        </button>
      ) : (
        <button type="button" className={`btn primary ${empty ? "" : "small"}`} disabled={busy} onClick={() => void connect()}>
          {busy ? "Asking GitHub…" : "Connect GitHub"}
        </button>
      )}
    </>
  );
  const code = pending && (
    <div className="gh-code-row">
      <button type="button" className="gh-code" title="Copy the code" onClick={() => void navigator.clipboard?.writeText(pending.userCode).then(() => setCopied(true), () => {})}>
        {pending.userCode}
      </button>
      <span className="muted small">{copied ? "Copied" : "Press to copy"}</span>
    </div>
  );
  if (bare)
    return (
      <div className="gh-connect bare">
        {pending && <div className="gh-sub">Enter this code on the page that opened, then approve. This finishes by itself.</div>}
        {code}
        {failed}
        <div className="gh-actions">{actions}</div>
        {dialog}
      </div>
    );
  if (empty)
    return (
      <section className="int-empty gh-empty">
        <span className="int-empty-mark">
          <GitHubMark size={24} />
        </span>
        <h2>{pending ? "Approve Friday on GitHub" : "Connect GitHub"}</h2>
        <p>{pending ? "Enter this code on the page that opened, then approve. This finishes by itself." : `${why ?? "See your pull requests, open your repos and push from Friday."} The login stays on this computer, where git keeps its own.`}</p>
        {code}
        {failed}
        <div className="int-empty-actions">{actions}</div>
        {dialog}
      </section>
    );
  return (
    <div className={`gh-connect ${compact ? "compact" : ""}`}>
      <span className="gh-mark" aria-hidden>
        <GitHubMark />
      </span>
      <div className="gh-body">
        <div className="gh-title">{pending ? "Approve Friday on GitHub" : "Connect GitHub"}</div>
        {pending ? (
          <>
            <div className="gh-sub">Enter this code on the page that opened, then approve. This finishes by itself.</div>
            {code}
          </>
        ) : (
          <div className="gh-sub">{why ?? "See your pull requests, open your repos and push from Friday."} The login stays on this computer, where git keeps its own.</div>
        )}
        {failed}
      </div>
      <div className="gh-actions">{actions}</div>
      {dialog}
    </div>
  );
}

/** GitHub's mark, drawn: it isn't among the app's icons, and it is what people look for on this button. */
export function GitHubMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
