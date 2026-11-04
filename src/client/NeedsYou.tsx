import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markOf, rankNeeds, waitedText, type Need } from "../needs-rank.js";
import { errorHead } from "../error-head.js";
import { isRawError } from "../activity-line.js";
import { api } from "./api.js";
import { Icon } from "./icons.js";
import { PageHeader } from "@/components/dass";
import { EmptyState } from "@/components/dass/EmptyState";
import { HandIcon } from "lucide-react";
import { PresenceRing } from "./presence.js";
import { usePrs } from "./prWatch.js";
import { shortPaths } from "./shortPaths.js";
import { Initials } from "./teammate-initials.js";
import { plainLine } from "./team-room.js";
import { EngineMark } from "./BrandMarks.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { Face, matesIn, openTeammate, ownOf, refreshTeam, RoomFaces, useTeam, type Team } from "./Teammates.js";
import { NEEDS_CHANGED, publishNeeds, withCode } from "./Attention.js";
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
const LEAD: Record<Need["kind"], string> = { question: "asks", ask: "asks", approval: "wants your OK", plan: "wants your OK on a plan", held: "sent a message", control: "wants control", handover: "handed you a session", stopped: "stopped", mention: "mentioned you", limit: "is out of usage", crew: "asked your teammate", review: "asked for your review", goal: "says a goal is slipping", check: "suggests a check" };

/** The coding tool a need is from, by the name it asks under ("Claude Code"). */
const toolOf = (who: string): EngineTool | undefined => (Object.keys(ENGINE_NAMES) as EngineTool[]).find((t) => ENGINE_NAMES[t] === who);

export function NeedsYou({ identity, recents, onReview, onCrew, onBoard }: { identity: Identity; recents: RecentSession[]; onReview: () => void; onCrew?: () => void; onBoard?: () => void }) {
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
  // Put off here, before the server next says so; and whether the put off ones are shown (audit CREW-6).
  const [offHere, setOffHere] = useState<Set<string>>(new Set());
  const [showOff, setShowOff] = useState(false);
  const list = useRef<HTMLOListElement | null>(null);

  const team = useTeam(identity);
  const hidden = team?.hidden ?? [];
  const sids = [...new Set([...recents.map((r) => r.sid), ...hidden])].join(",");
  const load = useCallback(async () => {
    try {
      const got = await api<{ items: Need[]; reviewsOff?: string[] }>(identity, "/api/needs-you", { method: "POST", body: JSON.stringify({ sids: sids ? sids.split(",") : [] }) });
      setItems(got.items);
      if (got.reviewsOff?.length) setOffHere((o) => (got.reviewsOff!.every((id) => o.has(id)) ? o : new Set([...o, ...got.reviewsOff!])));
      // Answered here and gone from the server's list too: forgotten, so the same item waiting again later shows again.
      const now = new Set(got.items.map((n) => n.id));
      setGone((g) => (g.size && [...g].some((id) => !now.has(id)) ? new Set([...g].filter((id) => now.has(id))) : g));
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
    addEventListener(NEEDS_CHANGED, now);
    addEventListener("focus", now);
    return () => {
      clearInterval(t);
      removeEventListener("friday:attention", now);
      removeEventListener(NEEDS_CHANGED, now);
      removeEventListener("focus", now);
    };
  }, [load]);

  // Pull requests waiting on your review, from your computer: ranked with the rest, opened in Code Review.
  const { prs } = usePrs();
  const ranked = useMemo(() => {
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
    return rankNeeds([...(items ?? []), ...reviews].filter((n) => !gone.has(n.id)).map((n) => (offHere.has(n.id) ? { ...n, putOff: true as const } : n)), at || Date.now());
  }, [items, prs, gone, offHere, at]);
  // Put off with "Not now": kept under one "N put off · Show" row rather than gone (audit CREW-6, 2026-11-04), and out of every count,
  // this page's heading, the badge, the sidebar, the Board and Home alike (2026-11-04 retest).
  const offN = ranked.filter((n) => n.putOff).length;
  const waitingN = ranked.length - offN;
  const shown = useMemo(() => ranked.filter((n) => !n.putOff).concat(showOff ? ranked.filter((n) => n.putOff) : []), [ranked, showOff]);
  // The list as it stands here is what the badge, the sidebar and the rows count, the moment it changes (Attention.tsx).
  const marksKey = items === null ? "" : ranked.map((n) => `${n.id}${n.putOff ? "~off" : ""}`).join("|");
  useEffect(() => {
    if (items === null) return;
    publishNeeds(
      ranked.filter((n) => n.kind !== "review").map(markOf),
      ranked.filter((n) => n.putOff).map((n) => n.id),
    );
  }, [marksKey]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // The sidebar's faces and rows and the crew list say it at once too, not on their next read (audit CREW-7, 2026-11-04).
    void refreshTeam(identity);
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
    if (n.putOff) return;
    // A review too, by its id, so it stays put off on every count and after a reload; the counts read it again once it is kept.
    void api(identity, "/api/needs-you/dismiss", { method: "POST", body: JSON.stringify({ id: n.id }) })
      .then(() => dispatchEvent(new Event("friday:attention")))
      .catch(() => {});
    setSaid(`Put off: ${n.text}`);
    const next = shown.filter((x) => !x.putOff && x.id !== n.id)[Math.min(index, shown.length - 2)];
    setOffHere((o) => new Set(o).add(n.id));
    if (next) (setCursor(next.id), focusRow(next.id));
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
      {/* Nothing waiting: the Board's pattern, an icon, a title, one line and the way on, with no hairline under it (audit REST-17,
          Arun 2026-11-04). */}
      {items !== null && !ranked.length && !error ? (
        <EmptyState
          icon={<HandIcon />}
          title="Nothing is waiting on you"
          action={
            onBoard && (
              <button type="button" className="link-btn ny-empty-go" onClick={onBoard}>
                Open the Agent Board →
              </button>
            )
          }
        >
          When an agent, a teammate or a room needs a decision from you, it waits here with Friday's suggested answer.
        </EmptyState>
      ) : !error || shown.length > 0 ? (
      <header className="ny-head">
        {/* Not read: no count, and never "Nothing is waiting on you" over the error saying it couldn't look (audit e2e, Arun
            2026-11-04). */}
        {!error && (
        <p className="ny-count" aria-live="polite">
          {items === null ? "Looking…" : waitingN ? `${waitingN} waiting on you, worst first` : offN ? "Nothing new is waiting on you" : "Nothing is waiting on you"}
        </p>
        )}
        {shown.length > 0 && (
          <p className="ny-keys" aria-hidden="true">
            <kbd>j</kbd>
            <kbd>k</kbd> move · <kbd>↵</kbd> take Friday's answer · <kbd>e</kbd> edit · <kbd>x</kbd> not now · <kbd>o</kbd> open
          </p>
        )}
      </header>
      ) : null}
      {error && (
        <p className="ny-error" role="alert">
          Couldn't read what's waiting: {error}
        </p>
      )}
      {shown.length > 0 && (
      <ol className="ny-list" ref={list}>
        {shown.map((n, i) => {
          const on = i === index;
          const s = n.suggestion;
          const pick = s && n.choices.find((c) => c.value === s.answer);
          // A coding tool's numbered questions are answered from their rows: no choice buttons saying them again (audit CREW-17).
          const others = n.asks?.length ? [] : n.choices.filter((c) => c !== pick);
          // A teammate asking wears its own face, with the badge the sidebar gives it (audit CREW-5, 2026-11-04).
          const mate = team?.teammates.find((m) => m.name === n.who);
          return (
            <li key={n.id} data-id={n.id} className={`ny-row${on ? " on" : ""}${n.putOff ? " off" : ""}`} tabIndex={on ? 0 : -1} aria-current={on || undefined} onFocus={() => setCursor(n.id)} onClick={() => setCursor(n.id)}>
              {mate ? (
                <span className="ny-face ny-mate">
                  <Face seed={mate.look ?? mate.name} size={32} status={n.kind === "stopped" ? "stopped" : "waiting"} lead={mate.lane === team?.lead} />
                </span>
              ) : (
                <PresenceRing state={n.kind === "stopped" ? "error" : "needs"} size={28} className="ny-face" square={!!toolOf(n.who)}>
                  {/* A coding tool asking shows its own mark, as everywhere else, not letters ("CC"); a person, their initials. */}
                  {toolOf(n.who) ? <EngineMark tool={toolOf(n.who)!} size={18} /> : <Initials seed={n.who} size={28} />}
                </PresenceRing>
              )}
              <div className="ny-body">
                <p className="ny-who">
                  <span className="ny-name">{n.who}</span> {LEAD[n.kind]}
                  {/* A room as a chip with its faces, rather than "in Crew" read as the crew (audit CREW-37, 2026-11-04). */}
                  {n.where.room && n.where.sid ? (
                    <span className="ny-room">
                      <RoomFaces seeds={matesIn(n.where.sid).slice(0, 3).map(({ m }) => m.look ?? m.name)} size={16} />
                      {n.where.sid === team?.sid ? "Crew room" : n.where.room}
                    </span>
                  ) : (
                    <span className="ny-where">
                      {" "}
                      in {n.where.title}
                    </span>
                  )}
                  <span className="ny-ago">{waitedText((at || Date.now()) - n.since)}</span>
                </p>
                <p className="ny-text">{withCode(shortPaths(n.text))}</p>
                {n.detail && (n.kind === "stopped" && isRawError(n.detail) ? <ErrorDetail text={n.detail} /> : <pre className="ny-detail">{shortPaths(n.detail)}</pre>)}
                {/* Its choices as its own answer card draws them, a press answering, and the questions after the first said once
                    under them (audit CREW-17, 2026-11-04). */}
                {!!n.asks?.[0]?.options.length && editing !== n.id && (
                  <div className="ny-opts" role="group" aria-label={n.text}>
                    {n.asks[0].options.map((o, k) => (
                      <button key={o.key} type="button" className="ny-opt" aria-disabled={!!busy || undefined} onClick={() => n.choices[k] && void answer(n, n.choices[k]!.value)}>
                        <span className="ny-opt-key">{o.key}</span>
                        <span className="ny-opt-text">
                          <b>{o.label}</b>
                          {o.detail && <span>{o.detail}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {n.asks?.slice(1).map((q) => (
                  <p key={q.question} className="ny-then">
                    Then: {q.question}
                  </p>
                ))}
                {n.why && <p className="ny-why">{n.where.room ? n.why.replace(`Holds up ${n.where.room}`, "Holds it up").replace(` in ${n.where.room}`, " here") : n.why}</p>}
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
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Escape") (e.stopPropagation(), setEditing(""), focusRow(n.id));
                        else if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), draft.trim() && void answer(n, draft, true));
                      }}
                    />
                    <div className="ny-actions">
                      <span className="ny-spacer" />
                      <button type="button" className="btn small ghost" onClick={() => (setEditing(""), focusRow(n.id))}>
                        Cancel
                      </button>
                      <button type="submit" className="btn small primary" aria-disabled={!draft.trim() || !!busy || undefined}>
                        {busy === n.id ? "Sending…" : "Send"}
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
                    {/* The quiet ones on the left, the suggested answer dark on the far right, as the room's own cards have it
                        (audit CREW-18, 2026-11-04). */}
                    <div className="ny-actions">
                      {!n.putOff && (
                        <button type="button" className="btn small ghost ny-quiet" onClick={() => void notNow(n)} title="x">
                          Not now
                        </button>
                      )}
                      <button type="button" className="btn small ghost ny-quiet" onClick={() => open(n)} title="o">
                        Open
                      </button>
                      <span className="ny-spacer" />
                      {n.free && (
                        <button type="button" className="btn small ghost" onClick={() => edit(n)} title="e">
                          {s ? "Edit" : "Answer"}
                        </button>
                      )}
                      {others.map((c) => (
                        <button key={c.value} type="button" className="btn small ghost" aria-disabled={!!busy || undefined} onClick={() => void answer(n, c.value)}>
                          {c.label}
                        </button>
                      ))}
                      {s && !n.asks?.length && (
                        <button type="button" className="btn small primary" aria-disabled={!!busy || undefined} onClick={() => void answer(n, s.answer)} title="Enter">
                          {busy === n.id ? "Sending…" : (pick?.label ?? "Send it")}
                        </button>
                      )}
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
      )}
      {offN > 0 && (
        <button type="button" className="ny-off" aria-expanded={showOff} onClick={() => setShowOff(!showOff)}>
          {offN} put off · <span>{showOff ? "Hide" : "Show"}</span>
        </button>
      )}
      {items !== null && !shown.length && !error && team && <CrewNow team={team} />}
      <span className="sr-only" role="status">
        {said}
      </span>
      </div>
    </div>
  );
}

/**
 * A coding tool's error on a stopped item: the line that says what went wrong, and the whole of it one press away, as the chat's
 * "stopped · error" has it. The card showed the whole stack trace in a box (2026-11-04 retest).
 */
function ErrorDetail({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="ny-err">
        <span>{shortPaths(errorHead(text))}</span>
        <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide the error" : "The whole error"}
        </button>
      </p>
      {open && <pre className="ny-detail">{shortPaths(text)}</pre>}
    </>
  );
}

// The ones at work first, then the ones stuck or out of usage, then those resting, then asleep.
const ORDER: Record<string, number> = { working: 0, waiting: 1, limited: 2, stopped: 3, idle: 4, offline: 5 };

/**
 * With nothing waiting, what the crew is doing now (Arun, 2026-11-04, of three empty states: B), so the page answers "is anything
 * happening?" as well as "does anything need me?". Each is a press from its own chat.
 */
function CrewNow({ team }: { team: Team }) {
  const mates = ownOf(team)
    .slice()
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!mates.length) return null;
  const working = mates.filter((m) => m.status === "working").length;
  const go = (lane: string) => openTeammate(team, lane, (r) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: r.sid, invite: r.invite } })));
  return (
    <section className="ny-crew" aria-label="Your crew right now">
      <div className="ny-crew-head">
        <b>Your crew right now</b>
        <span>{working ? `${working} working` : "Nobody working"}</span>
      </div>
      <ul className="ny-crew-list">
        {mates.map((m) => (
          <li key={m.id}>
            <button type="button" className={`ny-crew-row s-${m.status}`} onClick={() => go(m.lane)} title={`Open ${m.name}'s chat`}>
              <Face seed={m.look ?? m.name} size={28} status={m.status} lead={m.lane === team.lead} />
              <span className="ny-crew-text">
                <b>{m.name}</b>
                {/* One line, as previews are: "Done: I added a **Notes** section to `README.md`" showed its marks (2026-11-04 check). */}
                <span>{plainLine(m.line)}</span>
              </span>
              <span className="ny-crew-ago">{m.status === "working" ? "now" : m.lastAt ? waitedText(now - m.lastAt) : ""}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="ny-crew-foot">Anything they ask shows up at the top of this page, worst first.</p>
    </section>
  );
}
