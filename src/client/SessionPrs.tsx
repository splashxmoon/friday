import type { PullRequest } from "../runner/workspace.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { Icon } from "./icons.js";
import { openOutside } from "./openOutside.js";
import { usePrs } from "./prWatch.js";

/**
 * The pull requests a session opened, on its row in the sidebar (Arun, 2026-11-02: "can we add these kinda of things to the
 * coding session like tabs?"): a mark and how many, green while one waits to merge and purple once they all have, and on
 * hover each one with its title, where it stands, its repo and number and its lines in and out. Pressed, one opens on GitHub.
 * Its details are the ones Code Review already reads through this computer's GitHub login (prWatch.ts); one it doesn't know
 * says only its repo and number.
 */

// "open": one Code Review's list hasn't read yet, almost always one just opened.
type Stand = "ready" | "open" | "draft" | "merged" | "closed";
const WORD: Record<Stand, string> = { ready: "Ready", open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

const refOf = (url: string) => {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(url);
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
};

export function SessionPrBadge({ urls }: { urls: string[] }) {
  const { prs } = usePrs();
  if (!urls.length) return null;
  const merged = new Set((prs?.merged ?? []).map((p) => p.url));
  const known = new Map<string, PullRequest>([...(prs?.merged ?? []), ...(prs?.review ?? []), ...(prs?.mine ?? [])].map((p) => [p.url, p]));
  // Newest first, as the session opened them.
  const items = [...urls].reverse().map((url) => {
    const pr = known.get(url);
    const stand: Stand = merged.has(url) || pr?.mergedAt ? "merged" : pr ? (pr.draft ? "draft" : "ready") : "open";
    return { url, pr, stand, ref: refOf(url) };
  });
  const open = items.filter((i) => i.stand === "ready" || i.stand === "open").length;
  const tone = open ? "ready" : items.every((i) => i.stand === "merged") ? "merged" : "quiet";
  const say = `${urls.length} pull request${urls.length === 1 ? "" : "s"}${open ? `, ${open} open` : tone === "merged" ? ", merged" : ""}`;
  return (
    <HoverCard openDelay={150} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn("sb-pr", `t-${tone}`)}
          aria-label={say}
          onClick={(e) => {
            // The row opens the session; the mark is its pull requests'.
            e.stopPropagation();
            if (items.length === 1) openOutside(items[0]!.url);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Icon name={tone === "merged" ? "gitFork" : "gitPullRequest"} size={14} />
          {urls.length > 1 && <span className="sb-pr-n">{urls.length}</span>}
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={10} className="sb-pr-card">
        <ul className="sb-pr-list" aria-label="Pull requests from this session">
          {items.map(({ url, pr, stand, ref }) => (
            <li key={url}>
              <button type="button" className="sb-pr-item" onClick={() => openOutside(url)} title={url}>
                <span className="sb-pr-title">{pr?.title ?? (ref ? `${ref.repo} #${ref.number}` : url)}</span>
                <span className="sb-pr-meta">
                  <span className={`sb-pr-stand s-${stand}`}>
                    <Icon name={stand === "merged" ? "gitFork" : "gitPullRequest"} size={11} />
                    {WORD[stand]}
                  </span>
                  {ref && pr && (
                    <span className="sb-pr-where">
                      · {ref.repo} #{ref.number}
                    </span>
                  )}
                  {pr && (
                    <span className="sb-pr-lines">
                      <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </HoverCardContent>
    </HoverCard>
  );
}
