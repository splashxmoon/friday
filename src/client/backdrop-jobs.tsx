/**
 * A backdrop an agent is making or changing, as a card under Settings › Backdrop's box (Arun, 2026-11-20: "this open a session
 * stuff is hard to spot like we need more like status or something to help guide the user that it is being worked on, and like the
 * session can be opened"). The card is the session: what was asked, where its agent stands and what it is doing right now, how long
 * it has been at it, the backdrop itself as soon as a first save lands, and the one thing to do next (open it, answer it, change
 * what came out, try again). Kept in this browser, so leaving Settings, or reloading, never loses sight of it.
 */
import { useEffect, useState } from "react";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import type { CrewState } from "../attention.js";
import { doingWords } from "../step-words.js";
import { api } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { BackdropView, type BackdropsView, type FolderBackdrop } from "./backdrop.js";
import { Icon } from "./icons.js";
import { elapsed, useNow } from "./presence.js";
import type { Identity } from "./storage.js";
import { Button } from "@/components/ui/button";

export interface BackdropJob {
  sid: string;
  invite: string;
  tool: EngineTool;
  /** The person's own words. */
  said: string;
  at: number;
  /** Changing one of theirs: its folder. */
  target?: string;
  targetName?: string;
  /** The folders there were when it began: a new one is what it made. */
  before: string[];
  /** Once it has been seen at work: idle after that is finished, not starting. */
  worked?: true;
  /** When it settled (finished, stopped), so the clock stops there, and how: said the same after a reload, when its agent is no
   *  longer asked. */
  ended?: number;
  outcome?: { kind: "ready" | "empty" | "stopped"; word: string };
}

const KEY = "friday.backdrop.jobs";
const DAY = 24 * 3_600_000;
let jobs: BackdropJob[] = read();
const listeners = new Set<() => void>();

function read(): BackdropJob[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as BackdropJob[];
    return Array.isArray(raw) ? raw.filter((j) => j && typeof j.sid === "string" && Date.now() - j.at < DAY) : [];
  } catch {
    return [];
  }
}
function save(next: BackdropJob[]): void {
  jobs = next.slice(0, 3);
  try {
    localStorage.setItem(KEY, JSON.stringify(jobs));
  } catch {
    /* This window only. */
  }
  listeners.forEach((l) => l());
}
export const addJob = (j: BackdropJob) => save([j, ...jobs.filter((x) => x.sid !== j.sid)]);
const patchJob = (sid: string, p: Partial<BackdropJob>) => save(jobs.map((j) => (j.sid === sid ? { ...j, ...p } : j)));
const dropJob = (sid: string) => save(jobs.filter((j) => j.sid !== sid));

export function useJobs(): BackdropJob[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return jobs;
}

/** The folder a job made: the first one there now that wasn't when it began. */
export const madeBy = (j: BackdropJob, ids: string[]) => ids.find((id) => !j.before.includes(id));

type Live = { state: CrewState | "starting"; word: string; doing?: string; ask?: string };

/** Where the job's agent stands, read the way the sidebar reads every session (/api/attention), every few seconds while it runs. */
function useLive(identity: Identity, j: BackdropJob): Live {
  const [live, setLive] = useState<Live>({ state: "starting", word: "Starting" });
  useEffect(() => {
    if (j.ended) return;
    let on = true;
    const ask = async () => {
      const got = await api<{ items: { sid: string; text: string }[]; working?: { sid: string }[]; crews?: { sid: string; agents: { state: CrewState; word: string; doing?: { name: string; target?: string } }[] }[] }>(identity, "/api/attention", {
        method: "POST",
        body: JSON.stringify({ sids: [j.sid] }),
      }).catch(() => null);
      if (!on || !got) return;
      const agent = got.crews?.find((c) => c.sid === j.sid)?.agents[0];
      const item = got.items.find((i) => i.sid === j.sid);
      const working = !!got.working?.some((w) => w.sid === j.sid);
      const state: Live["state"] = item ? "needs" : working ? "working" : (agent?.state ?? "starting");
      setLive({ state: state === "idle" && !j.worked ? "starting" : state, word: agent?.word ?? "", ...(agent?.doing ? { doing: doingWords(agent.doing) } : {}), ...(item ? { ask: item.text } : {}) });
      if (state === "working" && !j.worked) patchJob(j.sid, { worked: true });
    };
    void ask();
    const t = setInterval(ask, 3_000);
    return () => ((on = false), clearInterval(t));
  }, [identity, j.sid, j.worked, j.ended]);
  return live;
}

const openSession = (j: BackdropJob) => dispatchEvent(new CustomEvent("friday:open-session", { detail: { sid: j.sid, invite: j.invite } }));

/** "12s", then "4m", "1h 5m": how long it has been at it. */
const took = (from: number, to: number) => (to - from < 60_000 ? `${Math.max(1, Math.round((to - from) / 1000))}s` : elapsed(from, to));

export function JobCard({ identity, job: j, view, onChange, onAgain }: { identity: Identity; job: BackdropJob; view: BackdropsView | null; /** Change what came out: the box, set to that one. */ onChange: (b: FolderBackdrop) => void; /** The same words, back in the box. */ onAgain: (said: string) => void }) {
  const live = useLive(identity, j);
  const now = useNow(1_000);
  const ready = view?.backdrops ?? [];
  const id = j.target ?? madeBy(j, ready.map((b) => b.id));
  const result = id ? ready.find((b) => b.id === id) : undefined;
  const draft = !result && (j.target ? undefined : view?.unfinished.find((u) => !j.before.includes(u.id)));
  const stopped = live.state === "failed" || live.state === "limited" || live.state === "offline" || live.state === "stopped" || live.state === "short";
  // Finished: idle again after it was seen at work, or (seen only after the fact: Settings was shut while it ran) with a backdrop to
  // show for it, or a while on. Never in its first moments, before its coding tool has begun.
  const evidence = j.worked || (!j.target && !!result) || now - j.at > 120_000;
  const finished = evidence && (live.state === "done" || live.state === "idle");
  const settled = finished || stopped;
  const clock = took(j.at, j.ended ?? now);
  const tool = ENGINE_NAMES[j.tool];

  // One kind at a time, its colour, its words and what to do about it; once settled, as it settled.
  const kind: "starting" | "working" | "needs" | "ready" | "empty" | "stopped" =
    j.outcome?.kind ?? (live.state === "needs" ? "needs" : stopped ? "stopped" : finished ? (result ? "ready" : "empty") : live.state === "working" || j.worked ? "working" : "starting");
  const word =
    j.outcome?.word ? j.outcome.word
    : kind === "starting" ? `Starting ${tool}`
    : kind === "working" ? (live.doing ?? (draft ? "Painting it" : "Working"))
    : kind === "needs" ? (live.ask ?? "Asking you something")
    : kind === "ready" ? (j.target ? "Changed · behind Friday now" : "Ready · behind Friday now")
    : kind === "empty" ? "Finished without saving a backdrop"
    : live.word || "Stopped";
  const title = j.target ? `Changing ${j.targetName ?? j.target}: ${j.said}` : j.said;
  useEffect(() => {
    if (settled && !j.ended && (kind === "ready" || kind === "empty" || kind === "stopped")) patchJob(j.sid, { ended: Date.now(), outcome: { kind, word } });
  }, [settled, j.sid, j.ended, kind, word]);

  return (
    <article className="bd-job" data-kind={kind} aria-label={`${title}: ${word}`}>
      <span className="bd-job-tile" aria-hidden>
        {result ? (
          <BackdropView key={result.v} shown={{ from: "folder", b: result }} still thumb />
        ) : (
          <span className="bd-job-wait">
            {kind === "needs" ? <Icon name="hand" size={16} /> : kind === "stopped" || kind === "empty" ? <Icon name="x" size={16} /> : <EngineMark tool={j.tool} size={16} />}
          </span>
        )}
      </span>
      <div className="bd-job-text">
        <p className="bd-job-title" title={title}>
          {title}
        </p>
        <p className="bd-job-status" role="status" aria-live="polite">
          <i className="bd-job-dot" aria-hidden />
          <span className="bd-job-word">{word}</span>
          <span className="bd-job-clock">{kind === "ready" || kind === "empty" || kind === "stopped" ? `took ${clock}` : clock}</span>
        </p>
      </div>
      <div className="bd-job-acts">
        {kind === "needs" ? (
          <Button type="button" size="sm" onClick={() => openSession(j)}>
            Answer in the session
          </Button>
        ) : (
          <>
            {kind === "ready" && result && (
              <Button type="button" variant="outline" size="sm" aria-label="Change it with an agent" onClick={() => (onChange(result), dropJob(j.sid))}>
                <Icon name="pencil" size={13} /> Change it
              </Button>
            )}
            {(kind === "empty" || kind === "stopped") && (
              <Button type="button" variant="outline" size="sm" onClick={() => (onAgain(j.said), dropJob(j.sid))}>
                <Icon name="refresh" size={13} /> Try again
              </Button>
            )}
            <Button type="button" variant={kind === "ready" ? "ghost" : "outline"} size="sm" onClick={() => openSession(j)}>
              Open the session <Icon name="arrowUpRight" size={13} />
            </Button>
          </>
        )}
        {(settled || !!j.outcome) && (
          <button type="button" className="icon-btn tiny bd-job-x" aria-label="Dismiss" title="Dismiss" onClick={() => dropJob(j.sid)}>
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
    </article>
  );
}

/** A job's unfinished folder in the picks: being made, its session a press away (Settings › Backdrop's grid). */
export const jobOfDraft = (all: BackdropJob[], id: string) => all.find((j) => !j.target && !j.ended && !j.before.includes(id));
export { openSession };
