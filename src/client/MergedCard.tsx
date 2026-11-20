import { useState } from "react";
import type { SessionEvent } from "../types.js";
import { Icon } from "./icons.js";
import { relTime } from "./ui.js";

// The merged card, loaded once a session's pull request has merged (Activity.tsx), so the session screen doesn't carry it before.
/**
 * The session's last card, once its pull request has merged: one slim card (Arun, 2026-11-18: "just make this simple and
 * slimmer"), in the chat's own card colour with GitHub's purple merge mark (2026-11-19: "get rid of this play it back bs, and make
 * this not green ... the standard card color with the purple merge icon ... add a little bit more detail"): "Merged #42" and what it
 * was, then where it went, how big it was, how long and how many runs it took and when it merged, and the pull request beside them.
 * It stays at the chat's end until it is put away with its ×, which this browser remembers for that pull request in that session
 * (Arun, 2026-11-20: "pin it but be able to dismiis it").
 */
const mergedGoneKey = (sid: string) => `friday.merged.dismissed.${sid}`;
export function MergedCard({ merged, events, replayLink, sid, onCopyReplay }: { merged: { url: string; at: number }; events: readonly SessionEvent[]; replayLink?: string | undefined; sid: string; /** The recording's link copied (Friday Team). */ onCopyReplay?: (link: string) => void }) {
  const [gone, setGone] = useState(() => {
    try {
      return localStorage.getItem(mergedGoneKey(sid)) === merged.url;
    } catch {
      return false;
    }
  });
  if (gone) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(mergedGoneKey(sid), merged.url);
    } catch {
      /* Put away for this visit only. */
    }
    setGone(true);
  };
  const pr = /\/pull\/(\d+)/.exec(merged.url)?.[1];
  const runs = events.filter((e) => e.body.type === "run.ended").length;
  const first = events.find((e) => e.body.type === "instruction" && e.actor.kind === "human");
  const days = first ? Math.round((merged.at - first.ts) / 86_400_000) : 0;
  // The commit that opened it: what it was called, its branch and base, and every push to that branch since.
  const opened = events.findLast((e) => e.body.type === "folder.committed" && !e.body.error && e.body.prUrl === merged.url);
  const ob = opened?.body.type === "folder.committed" ? opened.body : null;
  const pushes = ob ? events.filter((e) => e.body.type === "folder.committed" && !e.body.error && e.body.branch === ob.branch && e.seq >= opened!.seq).length : 0;
  const what = ob?.message.split("\n")[0]?.trim() ?? "";
  const when = ((t) => (t === "now" ? "just now" : `${t} ago`))(relTime(merged.at));
  const detail = [
    ob?.base ? `into ${ob.base}` : "",
    ob?.files ? `${ob.files} file${ob.files === 1 ? "" : "s"}` : "",
    pushes > 1 ? `${pushes} pushes` : "",
    days >= 1 ? `${days} day${days === 1 ? "" : "s"}` : "",
    runs ? `${runs} run${runs === 1 ? "" : "s"}` : "",
    `merged ${when}`,
  ].filter(Boolean);
  return (
    <div className="feed-merged slim" role="status">
      <span className="feed-merged-mark" aria-hidden="true">
        <Icon name="gitMerge" size={14} />
      </span>
      <span className="feed-merged-body">
        <span className="feed-merged-title" title={what || undefined}>
          <b>Merged{pr ? ` #${pr}` : ""}</b>
          {what && <span className="feed-merged-what"> · {what}</span>}
        </span>
        <span className="feed-merged-line">
          {ob?.branch && <code>{ob.branch}</code>}
          {detail.join(" · ")}
        </span>
      </span>
      <span className="feed-merged-actions">
        <a className="btn small" href={merged.url} onClick={(e) => (e.preventDefault(), window.open(merged.url, "_blank", "noopener"))}>
          Open pull request
        </a>
        <button type="button" className="icon-btn tiny feed-merged-x" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
          <Icon name="x" size={14} />
        </button>
      </span>
    </div>
  );
}

