import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { dangerOutline, Note, SettingsGroup, SettingsRow } from "@/components/dass";
import type { Pile, PileId } from "../runner/storage.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import { Skeleton, useConfirm } from "./ui.js";
import "./settings-storage.css";

/**
 * Settings › Storage (Arun, 2026-11-19: "we need to have proper storage management so it doesnt pile up and take so much disk
 * storage too"): what Friday keeps on this computer by kind, how much, and a clean-up now. The rules are runner/storage.ts's: a
 * branch is never deleted, uncommitted work waits a week in the trash, nothing an agent works in now is touched.
 */
type Measured = { piles: Pile[]; total: number; home: string; /** When it was measured (the server keeps the last one). */ at?: number; /** What Clean up now would clear this moment, and what goes by itself once it is a day old (storage.ts measure). Left out by an older runner. */ due?: number; soon?: number };
type Act = "tidy" | "trash" | "cache" | "older";
/** What a press is doing, as its button says it. */
const DOING: Record<Act, string> = { tidy: "Cleaning up…", trash: "Emptying…", cache: "Clearing…", older: "Moving…" };

const WORDS: Record<PileId, { label: string; hint: (n?: number) => string; tone: string }> = {
  copies: { label: "Agents' copies of your folders", hint: (n) => `${count(n, "folder")} for your sessions. One untouched for three days goes once nothing in it is uncommitted; its branch stays.`, tone: "#5b8def" },
  leftover: { label: "Copies no session uses", hint: (n) => `${count(n, "folder")} from deleted sessions, removed agents or test runs. Clean up clears them; uncommitted work goes to the trash.`, tone: "#e0884a" },
  older: { label: "Older copies", hint: (n) => `${count(n, "folder")} no session here names, untouched for three days or more: made before Friday marked its copies, or by another Friday on this computer. Moved to the trash only when you say.`, tone: "#c97b3c" },
  spares: { label: "Spare copies", hint: (n) => `${count(n, "folder")} made ahead, so a new agent starts at once. Ones a closed app left are cleared.`, tone: "#9b7bd8" },
  transcripts: { label: "Conversations of removed copies", hint: (n) => `${count(n, "folder")} Claude Code kept for copies Friday has removed, which can't be picked up again. Clean up moves them to the trash.`, tone: "#d0a05a" },
  trash: { label: "Trash", hint: () => "Copies that had uncommitted work, and conversations of removed copies. Each waits a week, then is deleted.", tone: "#d85b6a" },
  cache: { label: "Browser cache", hint: () => "The Preview's pages and the app's own, held to 256 MB each.", tone: "#3fae8c" },
  index: { label: "Change tracking", hint: () => "What Friday reads to show an agent's changes. A folder's goes after two weeks unused.", tone: "#c2a03a" },
  shots: { label: "Screenshots", hint: () => "Pictures agents took in the browser. They go with their session.", tone: "#4fb0c6" },
  logs: { label: "Session history", hint: () => "Every session's conversation. Deleting a session deletes its history.", tone: "#8a8f98" },
  models: { label: "Voice models", hint: () => "The speech-to-text models voice input downloaded.", tone: "#b07a5a" },
  other: { label: "Settings and everything else", hint: () => "Your settings, uploads and keys, and any folder Friday didn't make in its copies folder (never touched).", tone: "#6b7280" },
};
const ORDER: PileId[] = ["copies", "leftover", "older", "spares", "transcripts", "trash", "cache", "index", "shots", "logs", "models", "other"];

function count(n: number | undefined, word: string) {
  return `${n ?? 0} ${word}${n === 1 ? "" : "s"}`;
}

/** When the figures are from, in words: "just now", "4 minutes ago", "2 hours ago". */
function measuredWhen(at: number): string {
  const min = Math.floor((Date.now() - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} hour${h === 1 ? "" : "s"} ago` : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function StorageSection({ identity }: { identity: Identity }) {
  const [m, setM] = useState<Measured | null>(null);
  const [busy, setBusy] = useState<"" | Act>("");
  // Measuring again behind what is shown: the last measurement opens at once, the new one replaces it.
  const [updating, setUpdating] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [ask, confirmUI] = useConfirm();
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  const fail = (e: Error) => live.current && setNote({ ok: false, text: e.message || "Storage couldn't be measured." });
  const refresh = () => {
    setUpdating(true);
    return api<Measured>(identity, "/api/storage?fresh=1")
      .then((r) => live.current && setM(r), fail)
      .finally(() => live.current && setUpdating(false));
  };
  useEffect(() => {
    void api<Measured>(identity, "/api/storage").then((r) => {
      if (!live.current) return;
      setM(r);
      // Older than a minute: measured again, quietly, with "Updating…" beside the total.
      if (!r.at || Date.now() - r.at > 60_000) void refresh();
    }, fail);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (what: Act) => {
    setBusy(what);
    setNote(null);
    const before = m?.total ?? 0;
    try {
      const r = await api<Measured & { freed?: number }>(identity, `/api/storage/${what}`, { method: "POST" });
      if (!live.current) return;
      setM(r);
      const freed = what === "tidy" || what === "older" ? Math.max(0, before - r.total) : (r.freed ?? 0);
      setNote({ ok: true, text: freed > 0 ? `Freed ${bytes(freed)}.` : what === "tidy" ? "Nothing more to clear right now." : "Nothing to clear." });
    } catch (e) {
      fail(e as Error);
    } finally {
      if (live.current) setBusy("");
    }
  };
  // Friday's folder in Finder (the system's file manager elsewhere), from the desktop app.
  const desk = (window as { fridayDesktop?: { openIn?(target: string, path: string): Promise<{ ok: boolean; error?: string }> } }).fridayDesktop;
  const showFolder = async () => {
    if (!m || !desk?.openIn) return;
    const r = await desk.openIn("files", m.home).catch((e: Error) => ({ ok: false, error: e.message }));
    if (!r.ok) setNote({ ok: false, text: r.error || "The folder couldn't be shown." });
  };
  const mac = /Mac/.test(navigator.platform);

  const piles = m ? ORDER.map((id) => m.piles.find((p) => p.id === id)).filter((p): p is Pile => !!p) : [];
  const shown = piles.filter((p) => p.bytes > 0 || p.id === "copies" || p.id === "trash");
  // What Clean up would clear now, and what goes by itself once it's a day old: an older runner says neither, so all of the copies no
  // session uses count as clearable then, as before.
  const clearable = m?.due ?? m?.piles.find((p) => p.id === "leftover")?.bytes ?? 0;
  const soon = m?.due !== undefined ? (m.soon ?? 0) : 0;
  // Nothing for it to do (Arun, 2026-11-20: "grey out the clean up now if nothing is there to clear"); a press that just found nothing
  // greys it too, until the next measurement says otherwise.
  const idle = !!m && clearable === 0 && (m.due !== undefined || note?.text === "Nothing more to clear right now.");

  return (
    <section className="flex flex-col gap-5">
      <div className="sto-sum tray" aria-busy={!m || updating || !!busy}>
        <div className="sto-sum-top">
          <div className="sto-total">
            {m ? <b>{bytes(m.total)}</b> : <Skeleton w={120} h={30} r={8} />}
            <span>
              {m ? (
                <>
                  kept by Friday in <code>{m.home.replace(/^\/Users\/[^/]+|^\/home\/[^/]+|^[A-Z]:\\Users\\[^\\]+/i, "~")}</code>
                  <span className="sto-when" role="status">
                    {updating ? " · Updating…" : m.at ? ` · measured ${measuredWhen(m.at)}` : ""}
                  </span>
                </>
              ) : (
                "Adding up what Friday keeps on this computer…"
              )}
            </span>
          </div>
          <div className="sto-sum-acts">
            {m && desk?.openIn && (
              <Button variant="ghost" size="sm" onClick={() => void showFolder()}>
                {mac ? "Show in Finder" : "Show folder"}
              </Button>
            )}
            <Button size="sm" disabled={!m || !!busy || idle} title={idle ? (soon > 0 ? `Nothing to clear yet: ${bytes(soon)} of copies no session uses goes once each is a day old.` : "Nothing to clear right now.") : undefined} onClick={() => void act("tidy")}>
              {busy === "tidy" ? DOING.tidy : "Clean up now"}
            </Button>
          </div>
        </div>
        <div className="sto-bar" role="img" aria-label={m ? `Storage by kind: ${piles.filter((p) => p.bytes > 0).map((p) => `${WORDS[p.id].label} ${bytes(p.bytes)}`).join(", ")}` : "Measuring"}>
          {m && m.total > 0 && piles.map((p) => (p.bytes > 0 ? <i key={p.id} style={{ flexGrow: p.bytes, background: WORDS[p.id].tone }} title={`${WORDS[p.id].label}: ${bytes(p.bytes)}`} /> : null))}
        </div>
        <p className="sto-sum-note">
          {m && clearable > 0 ? `About ${bytes(clearable)} can go now: copies no session uses. ` : ""}
          {m && soon > 0 ? `${bytes(soon)} more goes once it's a day old. ` : ""}
          Friday also cleans up by itself a few minutes after it starts and every six hours. Branches are never deleted, and uncommitted work waits a week in the trash.
        </p>
        <Note className="sto-done">{note?.ok ? note.text : ""}</Note>
        <Note ok={false} className="sto-done">{note && !note.ok ? note.text : ""}</Note>
      </div>
      <SettingsGroup title="What's kept">
        {/* While the first measurement comes: rows in their own shape, so nothing jumps when it lands. */}
        {!m &&
          [62, 48, 40, 54, 44].map((w, i) => (
            <div key={i} className="sto-sk" aria-hidden="true">
              <div>
                <Skeleton w={`${w}%`} h={13} />
                <Skeleton w={`${w + 22}%`} h={11} />
              </div>
              <Skeleton w={56} h={13} />
            </div>
          ))}
        {shown.map((p) => (
          <SettingsRow
            key={p.id}
            label={
              <span className="sto-label">
                <i style={{ background: WORDS[p.id].tone }} aria-hidden="true" />
                {WORDS[p.id].label}
              </span>
            }
            hint={WORDS[p.id].hint(p.count)}
          >
            <span className="sto-size">{bytes(p.bytes)}</span>
            {p.id === "trash" && (
              <Button
                variant="outline"
                size="sm"
                className={dangerOutline}
                disabled={!p.bytes || !!busy}
                onClick={() =>
                  ask({
                    title: "Empty the trash?",
                    body: `${bytes(p.bytes)} of copies with uncommitted work are deleted for good. Their branches, and what was committed on them, stay.`,
                    action: "Empty trash",
                    onConfirm: () => act("trash"),
                  })
                }
              >
                {busy === "trash" ? DOING.trash : "Empty"}
              </Button>
            )}
            {p.id === "older" && p.bytes > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  ask({
                    title: `Move ${p.count === 1 ? "1 older copy" : `${p.count ?? 0} older copies`} to the trash?`,
                    body: "Each one's committed work stays on its branch. One with uncommitted changes goes to the trash, where it waits a week before it's deleted. A copy an agent is working in now is left alone.",
                    action: "Move to trash",
                    danger: false,
                    icon: "trash",
                    onConfirm: () => act("older"),
                  })
                }
              >
                {busy === "older" ? DOING.older : "Move to trash"}
              </Button>
            )}
            {p.id === "cache" && (
              <Button variant="outline" size="sm" disabled={!p.bytes || !!busy} onClick={() => void act("cache")}>
                {busy === "cache" ? DOING.cache : "Clear"}
              </Button>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
      {confirmUI}
    </section>
  );
}
