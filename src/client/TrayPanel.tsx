import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool } from "../types.js";
import type { Need } from "../needs-rank.js";
import { doingWords } from "../step-words.js";
import { useAttention } from "./Attention.js";
import { api, fileUrl } from "./api.js";
import { EngineMark } from "./BrandMarks.js";
import { FridayMark, Icon } from "./icons.js";
import { useMachine } from "./local.js";
import { startSession } from "./start-session.js";
import { loadRecents, type Identity, type RecentSession } from "./storage.js";
import { MenuButton, relTime } from "./ui.js";
import { isTeamSid } from "./Teammates.js";
import { TabRing } from "./presence.js";
import { useUnread } from "./unread.js";
import { folderName } from "./Workspace.js";
import "./tray.css";

/**
 * Friday in the menu bar (desktop-tray.ts; Arun, 2026-11-16, the approved mock): what needs you, with its one-tap answers;
 * what is working, each one's step this minute and for how long; what finished while you were away; a new task in any project;
 * and the coding tools' limits. Loaded once in a hidden window and kept, so it tells the menu bar's mark how things stand all the
 * time, and opening it is instant. Its own small page (?view=tray), not the app: nothing of the app's runs twice.
 */

type Tray = {
  state: (working: number, needs: number) => void;
  size: (height: number) => void;
  hide: () => void;
  open: (where: { sid?: string; invite?: string; view?: "needs" }) => void;
  onShown: (fn: () => void) => () => void;
  menu?: (items: { id: string; label: string; sub?: string; checked?: boolean }[], at: { x: number; y: number }) => Promise<string | null>;
};
const trayApi = (): Tray | undefined => (window as unknown as { fridayDesktop?: { tray?: Tray } }).fridayDesktop?.tray;

/** The coding tools' limits as the main window last read them (toolLimits.ts keeps them in this browser): read, never asked for. */
function limitsNow(): { name: string; pct: number }[] {
  try {
    const kept = JSON.parse(localStorage.getItem("mpa.limits") ?? "null") as { limits?: { claudeWindows?: { kind?: string; utilization?: number | null }[]; codexWindows?: { kind?: string; usedPercent?: number | null }[] } } | null;
    const l = kept?.limits;
    if (!l || typeof l !== "object") return [];
    const out: { name: string; pct: number }[] = [];
    const c = l.claudeWindows?.find((w) => w.kind === "five_hour") ?? l.claudeWindows?.[0];
    if (c && typeof c.utilization === "number") out.push({ name: "Claude", pct: Math.round(c.utilization * 100) });
    const x = l.codexWindows?.find((w) => w.kind === "primary") ?? l.codexWindows?.[0];
    if (x && typeof x.usedPercent === "number") out.push({ name: "Codex", pct: Math.round(x.usedPercent) });
    return out;
  } catch {
    return [];
  }
}

const clock = (since: number | undefined, now: number) => {
  if (!since) return "";
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function TrayRoot() {
  const [identity, setIdentity] = useState<Identity>({ id: "", name: "" });
  useEffect(() => {
    document.documentElement.classList.add("tray-view");
    void fetch("/api/me", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { user?: { id: string; name: string } } | null) => b?.user && setIdentity({ id: b.user.id, name: b.user.name }))
      .catch(() => {});
  }, []);
  return identity.id ? <TrayPanel identity={identity} /> : null;
}

function TrayPanel({ identity }: { identity: Identity }) {
  const tray = trayApi();
  // The sessions you have, as the main window keeps them in this browser: read again whenever it changes them.
  const [recents, setRecents] = useState<RecentSession[]>(loadRecents);
  useEffect(() => {
    const on = (e: StorageEvent) => e.key === "mpa.sessions" && setRecents(loadRecents());
    addEventListener("storage", on);
    return () => removeEventListener("storage", on);
  }, []);
  const a = useAttention(identity, recents);
  const unread = useUnread();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // What waits on you, with its answers, as the Needs you page lists it.
  const sids = recents.map((r) => r.sid).join(",");
  const [needs, setNeeds] = useState<Need[]>([]);
  const loadNeeds = useCallback(async () => {
    const got = await api<{ items: Need[] }>(identity, "/api/needs-you", { method: "POST", body: JSON.stringify({ sids: sids ? sids.split(",") : [] }) }).catch(() => null);
    if (got) setNeeds(got.items.filter((n) => !n.putOff && n.kind !== "review"));
  }, [identity, sids]);
  const needsKey = a.needs.map((n) => n.id).join(",");
  useEffect(() => void loadNeeds(), [loadNeeds, needsKey]);

  const titleOf = (sid: string) => ((r) => (r ? r.alias || r.title : "A session"))(recents.find((r) => r.sid === sid));
  const projectOf = (sid: string) => {
    const r = recents.find((x) => x.sid === sid);
    if (isTeamSid(sid)) return "Crew";
    const repo = r?.repos?.[0];
    return repo ? folderName({ name: repo.name, path: repo.path ?? "" }) : "";
  };
  // Working, less what waits on you: that one is in Needs you, with its answer, not twice.
  const waitingSids = new Set(needs.flatMap((n) => (n.where.sid ? [n.where.sid] : [])));
  const working = [...a.working.values()].filter((w) => !waitingSids.has(w.sid) && !a.needSids.has(w.sid)).sort((x, y) => (a.since.get(x.sid) ?? 0) - (a.since.get(y.sid) ?? 0));
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const done = recents.filter((r) => unread.has(r.sid) && !a.working.has(r.sid) && !a.needSids.has(r.sid)).slice(0, 3);

  // The menu bar's mark and its count follow what this reads.
  useEffect(() => {
    tray?.state(working.length, needs.length || a.needs.length);
  }, [working.length, needs.length, a.needs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // As tall as what it shows: the window follows.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || !tray) return;
    const ro = new ResizeObserver(() => tray.size(Math.ceil(el.scrollHeight) + 2));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tray]);

  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState("");
  const answer = async (n: Need, value: string) => {
    setBusy(n.id);
    setSaid("");
    try {
      const r = await api<{ said: string }>(identity, "/api/needs-you/answer", { method: "POST", body: JSON.stringify({ id: n.id, answer: value }) });
      setSaid(`${r.said}: sent to ${n.who}`);
      setNeeds((all) => all.filter((x) => x.id !== n.id));
      dispatchEvent(new Event("friday:attention"));
    } catch (e) {
      setSaid((e as Error).message || "That didn't go through.");
      void loadNeeds();
    } finally {
      setBusy("");
    }
  };
  const open = (sid?: string) => {
    const r = sid ? recents.find((x) => x.sid === sid) : undefined;
    tray?.open(sid ? { sid, ...(r?.invite ? { invite: r.invite } : {}) } : { view: "needs" });
  };

  // Opened: read now, and the task box takes the keyboard. Esc puts it away.
  const box = useRef<HTMLInputElement>(null);
  useEffect(
    () =>
      tray?.onShown(() => {
        setSaid("");
        dispatchEvent(new Event("friday:attention"));
        void loadNeeds();
        requestAnimationFrame(() => box.current?.focus());
      }),
    [loadNeeds], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && tray?.hide();
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [tray]);

  // A new task: in one of your projects, on one of your coding tools.
  const projects = useMemo(() => {
    const by = new Map<string, { name: string; path: string }>();
    for (const r of [...recents].sort((x, y) => y.openedAt - x.openedAt)) {
      const repo = r.repos?.[0];
      if (repo?.path && !by.has(repo.path)) by.set(repo.path, { name: folderName({ name: repo.name, path: repo.path }), path: repo.path });
    }
    return [...by.values()].slice(0, 12);
  }, [recents]);
  const [projectPath, setProjectPath] = useState("");
  const project = projects.find((p) => p.path === projectPath) ?? projects[0];
  const { state: machine } = useMachine(identity);
  const tools = ENGINE_TOOLS.filter((t) => machine.tools.some((x) => x.tool === t && x.path));
  const [tool, setTool] = useState<EngineTool | "">("");
  const toolNow: EngineTool | "" = tool && tools.includes(tool) ? tool : (tools.find((t) => machine.tools.some((x) => x.tool === t && x.loggedIn === true)) ?? tools[0] ?? "");
  const [task, setTask] = useState("");
  const startTask = async () => {
    if (!task.trim() || !project || !toolNow || busy) return;
    setBusy("task");
    setSaid("");
    try {
      const s = await startSession(identity, { path: project.path, tool: toolNow, text: task });
      setTask("");
      tray?.open({ sid: s.sid, invite: s.invite });
    } catch (e) {
      setSaid((e as Error).message || "That didn't start.");
    } finally {
      setBusy("");
    }
  };

  const limits = limitsNow();
  const waiting = needs.length;
  return (
    <main ref={root} className="tp" aria-label="Friday">
      <div className="tp-head">
        <span className="tp-logo" aria-hidden="true">
          <FridayMark size={14} />
        </span>
        <b>Friday</b>
        <span className="tp-sum">
          {working.length ? `${working.length} working` : "Nothing running"}
          {waiting ? ` · ${waiting} need${waiting === 1 ? "s" : ""} you` : ""}
        </span>
        <span className="tp-grow" />
        <button type="button" className="tp-icon" title="Open Friday" aria-label="Open Friday" onClick={() => tray?.open({})}>
          <Icon name="arrowUpRight" size={14} />
        </button>
      </div>

      {waiting > 0 && (
        <section aria-label="Needs you">
          <h4 className="tp-sec">
            Needs you <span>{waiting}</span>
          </h4>
          {needs.slice(0, 3).map((n) => (
            <div key={n.id} className="tp-ask">
              <div className="tp-ask-top">
                <span className="tp-ask-title">{n.where.title}</span>
                {n.where.sid && projectOf(n.where.sid) && <span className="tp-proj">{projectOf(n.where.sid)}</span>}
                <span className="tp-when">{relTime(n.since)}</span>
              </div>
              <p className="tp-ask-text">
                {n.text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>))}
              </p>
              {n.command && n.detail && <code className="tp-cmd">{n.detail.split("\n")[0]!.slice(0, 160)}</code>}
              <div className="tp-acts">
                {n.choices.slice(0, 2).map((c, i) => (
                  <button key={c.value} type="button" className={`tp-btn${i === 0 ? " primary" : ""}`} disabled={!!busy} onClick={() => void answer(n, c.value)}>
                    {busy === n.id && i === 0 ? <span className="spinner" /> : null}
                    {c.label}
                  </button>
                ))}
                <button type="button" className="tp-btn" onClick={() => open(n.where.sid)}>
                  Open <Icon name="arrowUpRight" size={12} />
                </button>
              </div>
            </div>
          ))}
          {waiting > 3 && (
            <button type="button" className="tp-more" onClick={() => open()}>
              {waiting - 3} more in Needs you
            </button>
          )}
        </section>
      )}

      {working.length > 0 && (
        <section aria-label="Working">
          <h4 className="tp-sec">
            Working <span>{working.length}</span>
          </h4>
          {working.map((w) => {
            const crew = a.crews.get(w.sid);
            const busyOne = crew?.agents.find((x) => x.state === "working") ?? crew?.agents[0];
            // What it is doing this minute, in words; the tool's name before it, as the sidebar's line says it.
            const step = busyOne?.doing ? doingWords(busyOne.doing) : busyOne?.word && busyOne.word !== "Working" ? busyOne.word : w.what;
            const who = busyOne?.tool ? ENGINE_NAMES[busyOne.tool] : busyOne?.name.replace(/^[^']+'s /, "");
            return (
              <button key={w.sid} type="button" className="tp-row" onClick={() => open(w.sid)}>
                <span className="tp-ring-slot"><TabRing state="working" /></span>
                <span className="tp-row-main">
                  <span className="tp-row-top">
                    {busyOne?.tool && <EngineMark tool={busyOne.tool} size={14} />}
                    <span className="tp-row-title">{titleOf(w.sid)}</span>
                    {projectOf(w.sid) && <span className="tp-proj">{projectOf(w.sid)}</span>}
                  </span>
                  <span className="tp-step">{who && !step.startsWith(who) ? `${who} · ${step}` : step}</span>
                </span>
                <span className="tp-time">{clock(a.since.get(w.sid), now)}</span>
              </button>
            );
          })}
        </section>
      )}

      {done.length > 0 && (
        <section aria-label="Done">
          <h4 className="tp-sec">
            Done <span>{done.length}</span>
          </h4>
          {done.map((r) => {
            const pr = a.prs.get(r.sid);
            const tool = a.crews.get(r.sid)?.agents[0]?.tool;
            return (
              <button key={r.sid} type="button" className="tp-row" onClick={() => open(r.sid)}>
                <span className="tp-ring-slot"><TabRing state="done" fresh /></span>
                <span className="tp-row-main">
                  <span className="tp-row-top">
                    {tool && <EngineMark tool={tool} size={14} />}
                    <span className="tp-row-title">{r.alias || r.title}</span>
                    {projectOf(r.sid) && <span className="tp-proj">{projectOf(r.sid)}</span>}
                  </span>
                  <span className="tp-step ok">{pr ? `${pr.merged ? "Merged" : "Pull request"} #${pr.url.split("/").pop()}` : "Finished while you were away"}</span>
                </span>
                {/* Its proof clip, playing quietly: what the work looks like, before opening it (Arun, 2026-11-16's approved mock had a
                    clip on each Done row; 2026-11-21: "add clips… see where else we can intergrate it"). */}
                {(() => {
                  const clip = a.facts.get(r.sid)?.clip;
                  return clip ? <video className="tp-clip" src={fileUrl(r.sid, r.invite, clip.file)} muted loop playsInline autoPlay={!still} preload="metadata" aria-hidden="true" /> : null;
                })()}
                <span className="tp-time">{a.since.get(r.sid) ? `${relTime(a.since.get(r.sid)!)} ago` : ""}</span>
              </button>
            );
          })}
        </section>
      )}

      {!waiting && !working.length && !done.length && <p className="tp-quiet">All quiet. Start something below, and it shows here while it works.</p>}

      {said && (
        <p className="tp-said" role="status">
          {said}
        </p>
      )}

      <form
        className="tp-new"
        onSubmit={(e) => {
          e.preventDefault();
          void startTask();
        }}
      >
        <Icon name="plus" size={14} />
        <input ref={box} value={task} onChange={(e) => setTask(e.target.value)} placeholder={project ? `New task in ${project.name}…` : "Open a project in Friday first"} aria-label="A new task" disabled={!project} />
        {projects.length > 1 && (
          <TrayPick tray={tray} label="Which project" items={projects.map((p) => ({ id: p.path, label: p.name, sub: p.path, checked: p.path === project?.path }))} onPick={setProjectPath}>
            <Icon name="folder" size={12} />
            <span>{project?.name ?? "Project"}</span>
          </TrayPick>
        )}
        {tools.length > 0 && (
          <TrayPick tray={tray} label="Which coding tool" items={tools.map((t) => ({ id: t, label: ENGINE_NAMES[t], checked: t === toolNow }))} onPick={(id) => setTool(id as EngineTool)}>
            {toolNow && <EngineMark tool={toolNow} size={12} />}
            <span>{toolNow ? ENGINE_NAMES[toolNow] : "Tool"}</span>
          </TrayPick>
        )}
        {busy === "task" && <span className="spinner" />}
      </form>

      <footer className="tp-foot">
        {limits.map((l) => (
          <span key={l.name} className="tp-limit">
            <span className="tp-gauge" style={{ ["--p" as string]: `${Math.min(100, l.pct)}%` }} aria-hidden="true" />
            {l.name} {l.pct}%
          </span>
        ))}
        <span className="tp-grow" />
        <button type="button" className="tp-link" onClick={() => tray?.open({})}>
          Open Friday
        </button>
      </footer>
    </main>
  );
}

/**
 * A picker in the panel: pressed, the Mac's own menu under it (desktop-tray.ts friday:tray-menu), which floats over everything; a
 * menu drawn in the page was cut to the panel's height (Arun, 2026-11-16: "fix design"). In a browser, the page's own menu.
 */
function TrayPick({ tray, label, items, onPick, children }: { tray: Tray | undefined; label: string; items: { id: string; label: string; sub?: string; checked?: boolean }[]; onPick: (id: string) => void; children: React.ReactNode }) {
  if (!tray?.menu)
    return (
      <MenuButton label={label} compact className="tp-pick" items={() => items.map((i) => ({ label: i.label, ...(i.sub ? { sub: i.sub } : {}), checked: !!i.checked, onSelect: () => onPick(i.id) }))}>
        {children}
        <Icon name="chevronDown" size={11} />
      </MenuButton>
    );
  return (
    <button
      type="button"
      className="tp-pick"
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        void tray.menu!(items, { x: r.left, y: r.bottom + 4 }).then((id) => id && onPick(id));
      }}
    >
      {children}
      <Icon name="chevronDown" size={11} />
    </button>
  );
}
