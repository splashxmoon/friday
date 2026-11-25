import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";

/**
 * Saving, said where it can be seen (spec 13, Arun 2026-11-24: "nothing a person did is ever lost"). Friday's server keeps
 * everything in one folder (local/kv.ts) and used to say nothing when it couldn't: a full disk only logged, and a saved state it
 * couldn't read was set aside while Friday opened empty. Now:
 * - "Friday can't save your work: the disk is full." while saving fails, gone by itself once a save goes through;
 * - once, as Friday opens: that it couldn't read its saved state, and opened the last good copy (or started fresh, the old file kept).
 *
 * Its own small root (local-main.tsx), beside the app rather than in it, so it still shows when the app can't draw. Told by the
 * server as things change (/api/local/saves/events), nothing polled.
 */

type SavesState = {
  failing?: { reason: string; since: number };
  notice?: { kind: "copy"; copyAt: number; at: number } | { kind: "fresh"; kept: string; at: number };
};

/** A time as people say it: "3:42 PM" today, "Nov 23, 3:42 PM" before. */
function said(at: number): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

function SaveBanner() {
  const [failing, setFailing] = useState<SavesState["failing"]>();
  // Kept on screen until OK, though the server forgets it as soon as it is told it was shown.
  const [notice, setNotice] = useState<SavesState["notice"] | null>(null);
  const told = useRef<number | null>(null);
  /** The failure put away with Hide: back if the reason changes, or saving works and then fails again. */
  const [hidden, setHidden] = useState<string | null>(null);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/local/saves/events");
    es.onmessage = (e) => {
      try {
        const s = JSON.parse(String(e.data)) as SavesState;
        setFailing(s.failing);
        if (s.notice) setNotice((had) => (had?.at === s.notice!.at ? had : s.notice!));
      } catch {
        // Not one of ours: kept as it was.
      }
    };
    return () => es.close();
  }, []);
  // Shown, so said: it isn't shown again after a reload or the next start.
  useEffect(() => {
    if (!notice || told.current === notice.at) return;
    told.current = notice.at;
    void fetch("/api/local/saves/seen", { method: "POST" }).catch(() => {});
  }, [notice]);
  const failure = failing ? `${failing.since}|${failing.reason}` : null;
  const showFailing = failing && failure !== hidden;
  if (!showFailing && !notice) return null;
  return (
    // Under the window's top row of buttons at phone width, where it would cover them.
    <div className="pointer-events-none fixed inset-x-0 top-[calc(var(--band,0px)+52px)] z-[90] flex flex-col items-center gap-2 px-4 sm:top-[calc(var(--band,0px)+12px)]">
      {failing && showFailing && (
        <div role="alert" className="save-banner pointer-events-auto flex w-full max-w-[520px] items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-strong)] bg-[var(--card)] px-4 py-3 text-[13px] leading-[18px] text-[var(--ink)] shadow-[var(--shadow-pop)]">
          <span aria-hidden="true" className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-[var(--red)]" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Friday can't save your work: {failing.reason}.</span>
            <span className="block text-[var(--text-muted)]">Keep Friday open: it keeps trying, and saves as soon as it can.</span>
          </span>
          <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setHidden(failure)}>
            Hide
          </Button>
        </div>
      )}
      {notice && (
        <div role="status" className="save-notice pointer-events-auto flex w-full max-w-[520px] items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-strong)] bg-[var(--card)] px-4 py-3 text-[13px] leading-[18px] text-[var(--ink)] shadow-[var(--shadow-pop)]">
          <span aria-hidden="true" className="mt-[5px] h-2 w-2 shrink-0 rounded-full bg-[var(--amber)]" />
          <span className="min-w-0 flex-1">
            {notice.kind === "copy" ? (
              <span className="block">
                Friday couldn't read its saved state, so it opened the copy from <span className="whitespace-nowrap">{said(notice.copyAt)}</span>.
              </span>
            ) : (
              <>
                <span className="block">Friday couldn't read its saved state, so it started fresh.</span>
                <span className="block text-[var(--text-muted)]">
                  The old file is kept at <span className="break-all font-[family-name:var(--mono)] text-[12px]">{notice.kept}</span>
                </span>
              </>
            )}
          </span>
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setNotice(null)}>
            OK
          </Button>
        </div>
      )}
    </div>
  );
}

/** Drawn in a root of its own, after the app's. */
export function mountSaveBanner(): void {
  const el = document.createElement("div");
  el.id = "save-banner";
  document.body.appendChild(el);
  createRoot(el).render(<SaveBanner />);
}
