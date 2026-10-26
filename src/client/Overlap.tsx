import { useMemo, useState } from "react";
import { DISMISS_MS } from "./focusDiff.js";
import type { Overlap } from "../collisions.js";
import { Icon } from "./icons.js";

/**
 * Somebody else is in the same file.
 *
 * Two sessions changing one file look fine from inside each of them; the
 * conflict only shows at merge, when both are finished and the cheap moment to
 * say something has passed. So this says it now, in the session, in the words
 * you would use: who, which file, and in which session — with a way to go and
 * look, because that is the only useful next move.
 *
 * It is a notice and not a lock. The common case is harmless (two people adding
 * to one config file), and a warning that can be waved away costs nothing where
 * a lock would have cost someone their afternoon.
 */

const keyOf = (o: Overlap) => `${o.path}|${o.others.map((x) => x.sid).sort().join(",")}`;

const STORE = "mpa.overlapGone";

/** What was dismissed and when, with what has aged out dropped. A storage that is not there is an empty one. */
function readGone(now = Date.now()): Map<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, number>;
    return new Map(Object.entries(raw).filter(([, at]) => typeof at === "number" && now - at < DISMISS_MS));
  } catch {
    return new Map();
  }
}
function writeGone(m: Map<string, number>) {
  try {
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(m)));
  } catch {
    // Dismissed for this visit only.
  }
}

export function OverlapNotice({ overlaps, onOpen }: { overlaps: Overlap[]; onOpen?: (sid: string, path: string) => void }) {
  // Remembered across visits, not just while this page is open: a notice you have read and dismissed should not come back at the
  // next poll or the next morning, but it should if the file is touched by somebody new, which changes its key.
  const [goneAt, setGoneAt] = useState<Map<string, number>>(() => readGone());
  const gone = useMemo(() => new Set(goneAt.keys()), [goneAt]);
  const dismiss = (keys: string[]) =>
    setGoneAt((cur) => {
      const next = new Map(cur);
      for (const k of keys) next.set(k, Date.now());
      writeGone(next);
      return next;
    });
  const [all, setAll] = useState(false);
  const live = overlaps.filter((o) => !gone.has(keyOf(o)));
  if (!live.length) return null;
  const shown = all ? live : live.slice(0, 2);

  return (
    <div className="overlap-notice" role="status" aria-label="Files another session is changing too">
      <div className="overlap-head">
        <span className="overlap-dot" />
        <span className="overlap-title">Someone else is changing {live.length === 1 ? "this file" : `these ${live.length} files`} too</span>
        <button type="button" className="icon-btn tiny" aria-label={live.length > 1 ? "Dismiss all" : "Dismiss"} title={live.length > 1 ? "Dismiss all" : "Dismiss"} onClick={() => dismiss(live.map(keyOf))}>
          <Icon name="x" size={12} />
        </button>
      </div>
      {shown.map((o) => {
        // A session of their own first, which they can open; a teammate's they aren't in is said by who only.
        const first = o.others.find((x) => !x.outside) ?? o.others[0]!;
        const more = o.others.length - 1;
        return (
          <div key={keyOf(o)} className="overlap-row">
            <span className="overlap-file" aria-hidden="true">
              <Icon name="file" size={14} />
            </span>
            <span className="overlap-text" title={o.path}>
              <span className="overlap-path">
                <span className="overlap-name">{o.path.split("/").pop()}</span>
                {o.path.includes("/") && <span className="overlap-dir">{o.path.split("/").slice(0, -1).join("/")}</span>}
              </span>
              <span className="overlap-by" title={first.outside ? undefined : first.title}>
                <span className="overlap-who">{first.by}</span>
                {" · "}
                {first.outside ? "a teammate's session" : first.title}
                {more > 0 ? ` and ${more} more` : ""}
              </span>
            </span>
            {onOpen && !first.outside && (
              <button type="button" className="overlap-open" onClick={() => onOpen(first.sid, o.path)}>
                Open
              </button>
            )}
            {/* One file: the toast's own close is enough. */}
            {live.length > 1 && (
              <button type="button" className="icon-btn tiny" aria-label={`Dismiss the notice about ${o.path}`} onClick={() => dismiss([keyOf(o)])}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        );
      })}
      {live.length > shown.length && (
        <button type="button" className="overlap-more" onClick={() => setAll(true)}>
          Show {live.length - shown.length} more file{live.length - shown.length === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
