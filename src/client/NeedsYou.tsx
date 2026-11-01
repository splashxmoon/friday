import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rankNeeds, waitedText, type Need } from "../needs-rank.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { PageHeader } from "@/components/dass";
import { PresenceRing } from "./presence.js";
import { usePrs } from "./prWatch.js";
import { shortPaths } from "./shortPaths.js";
import { Initials } from "./teammate-initials.js";
import { useTeam } from "./Teammates.js";
import { withCode } from "./Attention.js";
import type { Identity, RecentSession } from "./storage.js";
import "./needs-you.css";

/**
 * Needs you: everything waiting on you, across your sessions, Crew rooms and teammates, worst first, each with Friday's suggested
 * answer and why (Arun, 2026-10-31: "most decisions take one tap"). The list is the server's (needs-you.ts); pull requests waiting
 * on your review are read from your computer and ranked in here the same way (needs-rank.ts).
 *
 * j and k move, Enter takes the suggestion, e edits it, x puts it off, o opens where it was asked. Nothing is ever answered
 * without a press.
 */

const EVERY_MS = 10_000;

/** Whose face a row wears, and the words before what is asked. */
const LEAD: Record<Need["kind"], string> = { question: "asks", ask: "asks", approval: "wants your OK", plan: "wants your OK on a plan", held: "sent a message", control: "wants control", handover: "handed you a session", stopped: "stopped", mention: "mentioned you", limit: "is out of usage", crew: "asked your teammate", review: "asked for your review", goal: "says a goal is slipping" };

export function NeedsYou({ identity, recents, onReview, onCrew }: { identity: Identity; recents: RecentSession[]; onReview: () => void; onCrew?: () => void }) {
  const [items, setItems] = useState<Need[] | null>(null);
  const [error, setError] = useState("");
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [said, setSaid] = useState("");
  // Answered here: gone at once, before the server is next asked.
  const [gone, setGone] = useState<Set<string>>(new Set());
  const list = useRef<HTMLOListElement | null>(null);

  const hidden = useTeam(identity)?.hidden ?? [];
  const sids = [...new Set([...recents.map((r) => r.sid), ...hidden])].join(",");
  const load = useCallback(async () => {
    try {
      const got = await api<{ items: Need[] }>(identity, "/api/needs-you", { method: "POST", body: JSON.stringify({ sids: sids ? sids.split(",") : [] }) });
      setItems(got.items);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [identity, sids]);
  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), EVERY_MS);
    const now = () => void load();
    addEventListener("friday:attention", now);
    addEventListener("focus", now);
    return () => {
      clearInterval(t);
      removeEventListener("friday:attention", now);
      removeEventListener("focus", now);
    };
  }, [load]);

  // Pull requests waiting on your review, from your computer: ranked with the rest, opened in Code Review.
  const { prs } = usePrs();
  const shown = useMemo(() => {
    const reviews: Need[] = (prs?.review ?? []).map((p) => ({
      id: `review~${p.url}`,
      kind: "review",
      who: p.author,
      where: { title: p.repo },
      text: `#${p.number} ${p.title}`,
      choices: [{ label: "Review it", value: "open" }],
      free: false,
      since: Date.parse(p.requestedAt ?? p.createdAt ?? p.updatedAt) || Date.now(),
      blocks: { agents: 1, tasks: 0 },
      suggestion: { answer: "open", reason: p.checks === "failing" ? "Its checks are failing: say so, or wait for a fix." : `${p.changedFiles ?? p.files?.length ?? "A few"} files, checks ${p.checks === "passing" ? "passing" : p.checks}.`, by: "rule" },
      url: p.url,
      score: 0,
      why: "",
    }));
    return rankNeeds([...(items ?? []), ...reviews].filter((n) => !gone.has(n.id)), at || Date.now());
  }, [items, prs, gone, at]);
  // The minutes in "waited 4m" move on with the list's next read; between reads, once a minute.
  useEffect(() => {
    const t = setInterval(() => setAt(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const [cursor, setCursor] = useState("");
  const index = Math.max(0, shown.findIndex((n) => n.id === cursor));
  const current = shown[index];
  const focusRow = (id: string) => requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus());

  const open = (n: Need) => {
    if (n.kind === "review") return onReview();
    if (n.where.sid) return dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: n.where.sid } }));
    if (n.kind === "crew") onCrew?.();
  };

  const after = (n: Need) => {
    // Onto the next one, where the eye already is.
    const next = shown[index + 1] ?? shown[index - 1];
    setGone((g) => new Set(g).add(n.id));
    if (next) (setCursor(next.id), focusRow(next.id));
    dispatchEvent(new Event("friday:attention"));
  };

  const answer = async (n: Need, value: string, edited = false) => {
    if (busy) return;
    if (n.kind === "review" || (value === "" && !n.choices.length)) return open(n);
    setBusy(n.id);
    setRowError(null);
    try {
      const r = await api<{ said: string }>(identity, "/api/needs-you/answer", { method: "POST", body: JSON.stringify({ id: n.id, answer: value, edited }) });
      setSaid(`${r.said}: sent to ${n.who}`);
      setEditing("");
      after(n);
    } catch (e) {
      const text = (e as Error).message;
      setRowError({ id: n.id, text });
      // Answered somewhere else meanwhile: it goes, with the reason said.
      if (/no longer waiting/.test(text)) setTimeout(() => (after(n), void load()), 1200);
    } finally {
      setBusy("");
    }
  };

  const notNow = async (n: Need) => {
    if (n.kind !== "review") void api(identity, "/api/needs-you/dismiss", { method: "POST", body: JSON.stringify({ id: n.id }) }).catch(() => {});
    setSaid(`Put off: ${n.text}`);
    after(n);
  };

  const edit = (n: Need) => {
    if (!n.free) return;
    setEditing(n.id);
    setDraft(n.suggestion && !n.choices.some((c) => c.value === n.suggestion!.answer) ? n.suggestion.answer : "");
  };

  // The keys, while the page is open and nothing is being typed.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !current) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true]") || (t.closest("button") && e.key === "Enter"))) return;
      const move = (d: number) => {
        const n = shown[Math.min(shown.length - 1, Math.max(0, index + d))];
        if (n) (setCursor(n.id), focusRow(n.id));
      };
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (e.key === "Enter") current.suggestion ? void answer(current, current.suggestion.answer) : current.free ? edit(current) : open(current);
      else if (e.key === "e" && current.free) edit(current);
      else if (e.key === "o") open(current);
      else if (e.key === "x") void notNow(current);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  });

  return (
    <div className="page ny-page px-6! max-[640px]:px-4!">
      <div className="page-inner">
      <PageHeader title="Needs you" />
      <header className="ny-head">
        <p className="ny-count" aria-live="polite">
          {items === null && !error ? "Looking…" : shown.length ? `${shown.length} waiting on you, worst first` : "Nothing is waiting on you"}
        </p>
        {shown.length > 0 && (
          <p className="ny-keys" aria-hidden="true">
            <kbd>j</kbd>
            <kbd>k</kbd> move · <kbd>↵</kbd> take Friday's answer · <kbd>e</kbd> edit · <kbd>x</kbd> not now · <kbd>o</kbd> open
          </p>
        )}
      </header>
      {error && (
        <p className="ny-error" role="alert">
          Couldn't read what's waiting: {error}
        </p>
      )}
      {items !== null && !shown.length && !error && <p className="ny-empty">When an agent, a teammate or a room needs a decision from you, it waits here with Friday's suggested answer.</p>}
      <ol className="ny-list" ref={list}>
        {shown.map((n, i) => {
          const on = i === index;
          const s = n.suggestion;
          const pick = s && n.choices.find((c) => c.value === s.answer);
          const others = n.choices.filter((c) => c !== pick);
          return (
            <li key={n.id} data-id={n.id} className={`ny-row${on ? " on" : ""}`} tabIndex={on ? 0 : -1} aria-current={on || undefined} onFocus={() => setCursor(n.id)} onClick={() => setCursor(n.id)}>
              <PresenceRing state={n.kind === "stopped" ? "error" : "needs"} size={28} className="ny-face">
                <Initials seed={n.who} size={28} />
              </PresenceRing>
              <div className="ny-body">
                <p className="ny-who">
                  <span className="ny-name">{n.who}</span> {LEAD[n.kind]}
                  <span className="ny-where">
                    {" "}
                    in {n.where.room ?? n.where.title}
                  </span>
                  <span className="ny-ago">{waitedText((at || Date.now()) - n.since)}</span>
                </p>
                <p className="ny-text">{withCode(shortPaths(n.text))}</p>
                {n.detail && <pre className="ny-detail">{shortPaths(n.detail)}</pre>}
                {n.why && <p className="ny-why">{n.why}</p>}
                {editing === n.id ? (
                  <form
                    className="ny-edit"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (draft.trim()) void answer(n, draft, true);
                    }}
                  >
                    <textarea
                      autoFocus
                      value={draft}
                      rows={2}
                      aria-label={`Your answer to ${n.who}`}
                      placeholder={n.kind === "approval" ? "Don't, and do this instead…" : n.kind === "plan" ? "What to change in the plan…" : `Your answer to ${n.who}…`}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") (e.stopPropagation(), setEditing(""), focusRow(n.id));
                        else if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), draft.trim() && void answer(n, draft, true));
                      }}
                    />
                    <div className="ny-actions">
                      <button type="submit" className="btn small primary" aria-disabled={!draft.trim() || !!busy || undefined}>
                        {busy === n.id ? "Sending…" : "Send"}
                      </button>
                      <button type="button" className="btn small ghost" onClick={() => (setEditing(""), focusRow(n.id))}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    {s ? (
                      <p className="ny-suggest">
                        <Icon name="bulb" size={14} />
                        <span>
                          <span className="ny-suggest-by">{s.by === "asker" ? `${n.who} recommends` : "Friday suggests"}</span> <b>{pick?.label ?? `“${s.answer}”`}</b>
                          <span className="ny-reason"> · {s.reason}</span>
                        </span>
                      </p>
                    ) : n.thinking ? (
                      <p className="ny-suggest quiet">Friday is reading it…</p>
                    ) : n.noSuggestion ? (
                      <p className="ny-suggest quiet">{n.noSuggestion}</p>
                    ) : null}
                    <div className="ny-actions">
                      {s && (
                        <button type="button" className="btn small primary" aria-disabled={!!busy || undefined} onClick={() => void answer(n, s.answer)} title="Enter">
                          {busy === n.id ? "Sending…" : (pick?.label ?? "Send it")}
                        </button>
                      )}
                      {others.map((c) => (
                        <button key={c.value} type="button" className="btn small ghost" aria-disabled={!!busy || undefined} onClick={() => void answer(n, c.value)}>
                          {c.label}
                        </button>
                      ))}
                      {n.free && (
                        <button type="button" className="btn small ghost" onClick={() => edit(n)} title="e">
                          {s ? "Edit" : "Answer"}
                        </button>
                      )}
                      <span className="ny-spacer" />
                      <button type="button" className="btn small ghost ny-quiet" onClick={() => open(n)} title="o">
                        Open
                      </button>
                      <button type="button" className="btn small ghost ny-quiet" onClick={() => void notNow(n)} title="x">
                        Not now
                      </button>
                    </div>
                  </>
                )}
                {rowError?.id === n.id && (
                  <p className="ny-error" role="alert">
                    {rowError.text}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <span className="sr-only" role="status">
        {said}
      </span>
      </div>
    </div>
  );
}
