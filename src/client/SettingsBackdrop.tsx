/**
 * Settings › Backdrop (backdrop.tsx): describe one and an agent makes it in the backdrops folder (Arun,
 * 2026-11-20: "make it easy to prompt but also have the section in the settings too"), pick one of Friday's own, yours, or none,
 * add a picture or video of your own, and how it shows: dim, blur and motion.
 */
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { ENGINE_NAMES, ENGINE_TOOLS, type EngineTool } from "../types.js";
import { EngineMark } from "./BrandMarks.js";
import { BUILTINS, BackdropView, choose, reloadBackdrops, startBackdrops, useBackdrops, usePick, type Blur, type Dim, type FolderBackdrop } from "./backdrop.js";
import { Icon } from "./icons.js";
import { useMachine } from "./local.js";
import { joinPath, openIn, openTargets, type OpenTarget } from "./openIn.js";
import { addJob, jobOfDraft, JobCard, openSession, useJobs } from "./backdrop-jobs.js";
import { startSession } from "./start-session.js";
import type { Identity } from "./storage.js";
import { MenuButton } from "./ui.js";
import { Choice, Note, SettingsGroup, SettingsRow as Row } from "@/components/dass";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

const IDEAS = ["A slow ocean at night", "Rain running down a window", "Soft aurora over snow", "Paper and ink", "Warm sunset haze", "Stars drifting past"];
/** For changing one: the changes people ask of a backdrop most. */
const CHANGES = ["Brighter", "Darker, for night", "Slower motion", "Calmer in the middle", "Warmer colours", "More detail"];
const ADD = "image/jpeg,image/png,image/webp,image/avif,image/gif,video/mp4,video/webm,video/quicktime";

/** What the agent is asked: the description in the person's words, and where and how (the folder's AGENTS.md has the rest). */
const brief = (said: string, dir: string) =>
  `Make a new backdrop for Friday's window: ${said.trim()}\n\nFollow AGENTS.md in this folder (${dir}): a new folder here for it, with backdrop.json and an index.html, picture or video. Make it beautiful: a real scene or piece of art is welcome. Keep the middle calm and any motion slow, and check it before you are done.`;

/** Changing one of yours: that folder, in place, and nothing else (Arun, 2026-11-20: "add the option to edit the backdrop with the agent"). */
const change = (said: string, dir: string, b: FolderBackdrop) =>
  `Change the Friday backdrop "${b.name}" in the folder ${b.id}/ here: ${said.trim()}\n\nFollow AGENTS.md in this folder (${dir}). Change that folder's files in place, nothing outside it, and keep what isn't asked to change. Friday shows each save at once, so the person watches it as you go. Check it before you are done.`;

export function BackdropSection({ identity }: { identity: Identity }) {
  const view = useBackdrops();
  const pick = usePick();
  useEffect(() => {
    startBackdrops();
    void reloadBackdrops();
  }, []);
  const dir = view?.dir ?? "";

  // ── Make one ──
  const { state: machine } = useMachine(identity);
  const tools = ENGINE_TOOLS.filter((t) => machine.tools.some((x) => x.tool === t && x.path));
  const [tool, setTool] = useState<EngineTool | "">("");
  const toolNow: EngineTool | "" = tool && tools.includes(tool) ? tool : (tools.find((t) => machine.tools.some((x) => x.tool === t && x.loggedIn === true)) ?? tools[0] ?? "");
  const [said, setSaid] = useState("");
  /** The one of yours being changed, when the box is for that rather than a new one. */
  const [editing, setEditing] = useState<FolderBackdrop | null>(null);
  const [busy, setBusy] = useState(false);
  const jobs = useJobs();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const make = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!said.trim() || !toolNow || !dir || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const s = await startSession(identity, editing ? { path: dir, tool: toolNow, text: change(said, dir, editing), title: `Backdrop ${editing.name}: ${said.trim()}` } : { path: dir, tool: toolNow, text: brief(said, dir), title: `Backdrop: ${said.trim()}` });
      // The one being changed, showing, so each save is seen as it lands.
      if (editing) choose({ id: `f:${editing.id}` });
      addJob({ sid: s.sid, invite: s.invite, tool: toolNow, said: said.trim(), at: Date.now(), ...(editing ? { target: editing.id, targetName: editing.name } : {}), before: [...(view?.backdrops ?? []).map((b) => b.id), ...(view?.unfinished ?? []).map((u) => u.id)] });
      setSaid("");
      setEditing(null);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message || "That didn't start." });
    } finally {
      setBusy(false);
    }
  };

  // ── Add a picture or video ──
  const [over, setOver] = useState(false);
  const add = async (file: File | undefined) => {
    if (!file) return;
    setNote(null);
    if (!ADD.split(",").includes(file.type)) return setNote({ ok: false, text: "A backdrop can be a JPEG, PNG, WebP, AVIF or GIF picture, or an MP4, WebM or MOV video." });
    setBusy(true);
    try {
      const r = await fetch(`/api/local/backdrops?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const j = (await r.json().catch(() => ({}))) as { error?: string; backdrop?: FolderBackdrop };
      if (!r.ok || !j.backdrop) throw new Error(j.error ?? "Couldn't add it.");
      choose({ id: `f:${j.backdrop.id}` });
      await reloadBackdrops();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void add(e.dataTransfer.files[0]);
  };

  // ── Your folder, in the file manager ──
  const [files, setFiles] = useState<OpenTarget | null>(null);
  useEffect(() => {
    void openTargets().then((t) => setFiles(t.find((x) => x.id === "files") ?? null));
  }, []);
  const show = (path: string) => files && void openIn(files, path).then((err) => err && setNote({ ok: false, text: err }));
  const remove = async (b: FolderBackdrop) => {
    const r = await fetch(`/api/local/backdrops/${encodeURIComponent(b.id)}`, { method: "DELETE" }).catch(() => null);
    if (!r?.ok) return setNote({ ok: false, text: `Couldn't take ${b.name} out.` });
    if (pick.id === `f:${b.id}`) choose({ id: "none" });
    setNote({ ok: true, text: `${b.name} is in Friday's trash.` });
    await reloadBackdrops();
  };

  const none = pick.id === "none";
  const yours = view?.backdrops ?? [];
  const pickedOne = yours.find((b) => `f:${b.id}` === pick.id);
  const moves = pickedOne ? pickedOne.kind !== "image" : BUILTINS.find((b) => `b:${b.id}` === pick.id)?.moves;
  return (
    <section className="flex flex-col gap-6">
      {/* Describe one: an agent makes it in the backdrops folder, and it is picked as soon as it is saved. */}
      {/* Describe one, or what to change in one of yours: an agent does it in the backdrops folder. As the message box is: the words,
          then who does it and the arrow; ideas under it. */}
      <form className="bd-make" onSubmit={make} aria-label={editing ? `Change ${editing.name}` : "Make a backdrop"}>
        {editing && (
          <div className="bd-editing">
            <span className="bd-editing-thumb" aria-hidden>
              <BackdropView shown={{ from: "folder", b: editing }} still thumb />
            </span>
            <span className="bd-editing-name">Changing {editing.name}</span>
            <button type="button" className="icon-btn tiny" aria-label="Make a new one instead" title="Make a new one instead" onClick={() => (setEditing(null), box.current?.focus())}>
              <Icon name="x" size={13} />
            </button>
          </div>
        )}
        <textarea
          ref={box}
          rows={2}
          value={said}
          aria-label="Describe a backdrop"
          placeholder={editing ? "What should change? Brighter sky, fewer clouds, slower water…" : "Describe a backdrop: a city at night, rain on a window, a quiet forest…"}
          onChange={(e) => setSaid(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void make(e as unknown as FormEvent);
            if (e.key === "Escape" && editing) setEditing(null);
          }}
        />
        <div className="bd-make-foot">
          {toolNow && (
            <MenuButton
              label="Which coding tool does it"
              text={ENGINE_NAMES[toolNow]}
              mark={<EngineMark tool={toolNow} size={14} />}
              compact
              items={() => tools.map((t) => ({ label: ENGINE_NAMES[t], mark: <EngineMark tool={t} size={14} />, checked: t === toolNow, onSelect: () => setTool(t) }))}
            />
          )}
          <button className="send" type="submit" aria-label={editing ? "Change it" : "Make it"} title={editing ? "Change it" : "Make it"} disabled={!said.trim() || !toolNow || !dir || busy}>
            {busy ? <span className="spinner" /> : <Icon name="arrowUp" size={17} />}
          </button>
        </div>
      </form>
      <div className="bd-ideas" role="group" aria-label="Ideas">
        {(editing ? CHANGES : IDEAS).map((i) => (
          <button key={i} type="button" className="bd-idea" onClick={() => (setSaid(i), box.current?.focus())}>
            {i}
          </button>
        ))}
      </div>
      {jobs.length ? (
        <div className="bd-jobs">
          {jobs.map((j) => (
            <JobCard
              key={j.sid}
              identity={identity}
              job={j}
              view={view}
              onChange={(b) => void (setEditing(b), setSaid(""), setTimeout(() => box.current?.focus(), 50))}
              onAgain={(words) => void (setSaid(words), setTimeout(() => box.current?.focus(), 50))}
            />
          ))}
        </div>
      ) : (
        <p className="bd-made">{toolNow ? "Or ask any agent, in any session, for “a Friday backdrop of …”." : "Making one needs a coding tool on this computer: Settings › Coding tools."}</p>
      )}

      <div
        className="look-picks bd-picks"
        role="radiogroup"
        aria-label="Backdrop"
        data-over={over || undefined}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <div className="bd-pick">
          <button type="button" role="radio" aria-checked={none} className="look-pick" data-on={none || undefined} onClick={() => choose({ id: "none" })}>
            <span className="look-thumb bd-thumb bd-none" aria-hidden>
              <Icon name="x" size={16} />
            </span>
            <span className="look-pick-name">None</span>
          </button>
        </div>
        {BUILTINS.map((b) => {
          const on = pick.id === `b:${b.id}`;
          return (
            <div key={b.id} className="bd-pick">
              <button type="button" role="radio" aria-checked={on} className="look-pick" data-on={on || undefined} onClick={() => choose({ id: `b:${b.id}` })}>
                <span className="look-thumb bd-thumb" aria-hidden>
                  <BackdropView shown={{ from: "builtin", b }} still thumb />
                </span>
                <span className="look-pick-name">{b.name}</span>
              </button>
            </div>
          );
        })}
        {yours.map((b) => {
          const on = pick.id === `f:${b.id}`;
          return (
            <div key={b.id} className="bd-pick">
              <button type="button" role="radio" aria-checked={on} className="look-pick" data-on={on || undefined} title={`${b.name} · ${b.id}/${b.file}`} onClick={() => choose({ id: `f:${b.id}` })}>
                <span className="look-thumb bd-thumb" aria-hidden>
                  <BackdropView key={b.v} shown={{ from: "folder", b }} still thumb />
                </span>
                <span className="look-pick-name">{b.name}</span>
              </button>
              <span className="bd-more">
                <MenuButton
                  label={`${b.name}: more`}
                  end
                  compact
                  items={() => [
                    toolNow && { label: "Change with an agent", icon: "pencil", onSelect: () => void (setEditing(b), setSaid(""), box.current?.scrollIntoView({ block: "center", behavior: "smooth" }), setTimeout(() => box.current?.focus(), 50)) },
                    files && { label: "Show in folder", icon: "folderOpen", onSelect: () => show(joinPath(dir, b.id)) },
                    { label: "Move to trash", icon: "trash", danger: true, onSelect: () => void remove(b) },
                  ]}
                />
              </span>
            </div>
          );
        })}
        {view?.unfinished.map((u) => {
          // Its agent still at it: being made, and a press opens its session.
          const job = jobOfDraft(jobs, u.id);
          return (
            <div key={u.id} className="bd-pick">
              {job ? (
                <button type="button" className="look-pick" title={`Being made by ${ENGINE_NAMES[job.tool]}: open the session`} onClick={() => openSession(job)}>
                  <span className="look-thumb bd-thumb" data-making aria-hidden>
                    <EngineMark tool={job.tool} size={14} />
                    Being made
                  </span>
                  <span className="look-pick-name">{u.id}</span>
                </button>
              ) : (
                <div className="look-pick" title={u.why}>
                  <span className="look-thumb bd-thumb" data-unfinished aria-hidden>
                    Not ready yet
                  </span>
                  <span className="look-pick-name">{u.id}</span>
                </div>
              )}
            </div>
          );
        })}
        <div className="bd-pick bd-add">
          <label className="look-pick">
            <span className="look-thumb" aria-hidden>
              <Icon name="plus" size={16} />
            </span>
            <span className="look-pick-name">Add a picture or video</span>
            <input type="file" accept={ADD} disabled={busy} onChange={(e) => (void add(e.target.files?.[0]), (e.target.value = ""))} />
          </label>
        </div>
      </div>
      {note && <Note ok={note.ok}>{note.text}</Note>}
      <p className="bd-made">Light or dark follows the backdrop: Friday turns dark over a dark one and light over a light one. Appearance's choice is back with None, and in Code.</p>

      <SettingsGroup title="How it shows">
        <Row label="Dim" hint="A veil of its own light or dark over it, so words read easily.">
          <Choice<`${Dim}`>
            label="Dim"
            disabled={none}
            value={`${pick.dim}`}
            onChange={(v) => choose({ dim: Number(v) as Dim })}
            options={[
              ["0", "None"],
              ["20", "Light"],
              ["40", "Medium"],
              ["60", "Strong"],
            ]}
          />
        </Row>
        <Row label="Blur" hint="Softens it, for a busy picture.">
          <Choice<`${Blur}`>
            label="Blur"
            disabled={none}
            value={`${pick.blur}`}
            onChange={(v) => choose({ blur: Number(v) as Blur })}
            options={[
              ["0", "None"],
              ["8", "Soft"],
              ["24", "Strong"],
            ]}
          />
        </Row>
        <Row label="Motion" hint={moves === false ? "This one is still." : "Off shows a still frame. Off on its own when your computer or Appearance asks for less motion."}>
          <Switch aria-label="Motion" disabled={none || moves === false} checked={pick.motion} onCheckedChange={(on) => choose({ motion: on })} />
        </Row>
        <Row label="Folder" hint="Each backdrop is a folder here: a picture, a video or a page. Its AGENTS.md says how to make one.">
          <div className="bd-folder">
            <code title={dir}>{dir}</code>
            {files && dir && (
              <Button type="button" variant="outline" size="sm" onClick={() => show(dir)}>
                Open
              </Button>
            )}
          </div>
        </Row>
      </SettingsGroup>
    </section>
  );
}
