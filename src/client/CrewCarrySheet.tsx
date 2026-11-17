// The hand-off sheet (Code and Crew, connected, ported to the open-source edition from Friday Teams e4d637ea, 773e15e7, 7afa7b97
// and cd68a6b5, KeepGoingSheet.tsx): who takes it and what happens with each, what goes with it, a line of your own on top, and
// what they may do without asking. Everything is filled in from the session, so the common case is one tap. Loaded the first time
// it is opened (crew-carry-open.tsx). On this computer the choices are your crew and your crew rooms.
import { useEffect, useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ASK_KEYS, ASK_WORDS, carryRows, CARRY_DEFAULT, type AskKey, type CarryKey } from "../crew-carry-rules.js";
import { Icon } from "./icons.js";
import { CheckIcon } from "lucide-react";
import { kgPath, type BringAsk, type KeepGoingAsk } from "./crew-carry-open.js";
import { carryReq as workReq } from "./crew-carry-req.js";
import { Face } from "./Teammates.js";
import { roleWord } from "./team-status.js";

/** What it asks before, in the sheet's one line ("Asks you before opening a PR and merging"). */
const ASK_LINE: Record<AskKey, string> = { pr: "opening a PR", merge: "merging", migrations: "running migrations", commands: "running any command" };
/** What goes with it, said short on its chip; the whole line is its name. */
const CARRY_SHORT: Record<CarryKey, (line: string) => string> = {
  leftOff: () => "Where we left off",
  branch: (l) => ((m) => (m ? `Branch + ${m[1]} file${m[1] === "1" ? "" : "s"}` : l.startsWith("The branch") ? "The branch" : l))(/(\d+) uncommitted/.exec(l)),
  question: () => "The open question",
  conversation: () => "Whole conversation",
};

type Row = { id: string; name: string; role?: string; look?: string; line: string; now?: boolean };
type Sheet = {
  sid: string;
  lane: string;
  title: string;
  branch: string;
  own: Row[];
  rooms?: { id: string; name: string; to: string; mates: string[]; line: string }[];
  carry: { open: number; decided: number; branch: string; files: number; question: string; turns: number };
  note: string;
  ask: AskKey[];
  handed: { job: string; mateName: string } | null;
  finisher: { name: string; role: string; tool: string; model?: string; projects?: string[] } | null;
};
type Pick = { kind: "own" | "room"; id: string };

const notice = (text: string) => dispatchEvent(new CustomEvent("friday:notice", { detail: text }));
const first = (n: string) => n.split(/\s+/)[0] || n;

export function KeepGoingSheet({ ask, onClose }: { ask: KeepGoingAsk; onClose: () => void }) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [err, setErr] = useState("");
  const [pick, setPick] = useState<Pick | null>(null);
  const [carry, setCarry] = useState<Record<CarryKey, boolean>>({ ...CARRY_DEFAULT });
  const [note, setNote] = useState(ask.note ?? "");
  const [asks, setAsks] = useState<Set<AskKey>>(new Set());
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async (choose?: string) => {
    try {
      const s = await workReq<Sheet>(kgPath(ask.sid, ask.invite, "", ask.lane ? `&lane=${encodeURIComponent(ask.lane)}` : ""));
      setSheet(s);
      setAsks((had) => (had.size ? had : new Set(s.ask)));
      setNote((n) => n || s.note);
      const named = choose ?? (ask.mate ? s.own.find((m) => m.name.toLowerCase() === ask.mate!.toLowerCase())?.id : undefined);
      setPick((p) => (named ? { kind: "own", id: named } : (p ?? (s.own[0] ? { kind: "own", id: s.own[0].id } : null))));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen: Row | null = useMemo(() => {
    if (!sheet || !pick) return null;
    if (pick.kind === "room") return ((r) => (r ? { id: r.id, name: r.name, line: r.line } : null))((sheet.rooms ?? []).find((x) => x.id === pick.id));
    return sheet.own.find((x) => x.id === pick.id) ?? null;
  }, [sheet, pick]);
  const rows = sheet ? carryRows({ ...sheet.carry, branch: sheet.carry.branch || undefined, question: sheet.carry.question || undefined }) : [];

  const makeFinisher = async () => {
    if (!sheet?.finisher) return;
    setBusy(true);
    try {
      const r = await workReq<{ made?: string; teammates?: { id: string; name: string }[] }>("/api/teammates", { method: "POST", body: JSON.stringify(sheet.finisher) });
      await load(r.made ?? r.teammates?.find((t) => t.name === sheet.finisher!.name)?.id);
    } catch (e) {
      notice((e as Error).message);
    }
    setBusy(false);
  };

  const send = async () => {
    if (!sheet || !pick || !chosen || busy) return;
    setBusy(true);
    try {
      if (pick.kind === "room") {
        await workReq(kgPath(ask.sid, ask.invite), { method: "POST", body: JSON.stringify({ room: pick.id, lane: sheet.lane, carry, note }) });
        notice(`Handed to the room ${chosen.name}.`);
      } else {
        await workReq(kgPath(ask.sid, ask.invite), { method: "POST", body: JSON.stringify({ mate: pick.id, lane: sheet.lane, carry, note, ask: [...asks] }) });
      }
      // The sidebar's row and the crew's pages, now rather than at their next read: "Rio is on it", and Rio's new thread.
      dispatchEvent(new Event("friday:attention"));
      dispatchEvent(new Event("friday:teammates"));
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  /**
   * Who, as faces (Friday Teams 2117b78a; Arun, 2026-11-14, design 1 of three: "I SAID TO DESIGN THIS BETTER"): your crew mates and
   * your crew rooms in one row of mascots, a dot on each for whether it can start now; one line under the row says who that is and
   * what happens.
   */
  const lookOf = (name: string) => sheet?.own.find((m) => m.name === name)?.look ?? name;
  const face = (kind: Pick["kind"], r: { id: string; name: string; look?: string; now?: boolean; mates?: string[] }) => {
    const on = pick?.kind === kind && pick.id === r.id;
    return (
      <button key={`${kind}:${r.id}`} type="button" role="radio" aria-checked={on} aria-label={r.name} className="kg-face" data-on={on || undefined} onClick={() => setPick({ kind, id: r.id })}>
        <span className="kg-face-mark">
          {kind === "room" ? (
            <span className="kg-face-room" aria-hidden="true">
              {(r.mates ?? []).slice(0, 3).map((n) => (
                <Face key={n} seed={lookOf(n)} size={18} />
              ))}
              {!r.mates?.length && <Icon name="users" size={16} />}
            </span>
          ) : (
            <Face seed={r.look ?? r.name} size={30} />
          )}
          <span className="kg-face-dot" data-now={kind === "room" || r.now ? "" : undefined} aria-hidden="true" />
        </span>
        <span className="kg-face-name">{r.name}</span>
      </button>
    );
  };
  const pickLine = chosen ? [chosen.name, pick?.kind === "own" && chosen.role ? roleWord(chosen.role) : pick?.kind === "room" ? "Crew room" : "", chosen.line.replace(/\.$/, "")].filter(Boolean).join(" · ") : "";
  const asksLine = asks.size ? `Asks you before ${new Intl.ListFormat("en", { type: "conjunction" }).format(ASK_KEYS.filter((k) => asks.has(k)).map((k) => ASK_LINE[k]))}` : "Doesn't ask you before anything";
  const crewFaces = !!sheet && (sheet.own.length > 0 || (sheet.rooms ?? []).length > 0 || !!sheet.finisher);

  const toName = chosen ? first(chosen.name) : "";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="kg-sheet sm:max-w-[520px]">
        <form onSubmit={(e) => (e.preventDefault(), void send())}>
          <DialogHeader>
            <DialogTitle>Keep this going</DialogTitle>
            <DialogDescription>{sheet ? [sheet.title, sheet.branch].filter(Boolean).join(" · ") : "Reading where it stands…"}</DialogDescription>
          </DialogHeader>
          {sheet?.handed && <p className="kg-hint">{sheet.handed.mateName} is already on this. Take it back from the session first.</p>}
          {sheet && (
            <>
              <div className="kg-who-wrap" role="radiogroup" aria-label="Who">
                {crewFaces && (
                  <div className="kg-faces">
                    {sheet.own.map((r) => face("own", r))}
                    {(sheet.rooms ?? []).map((r) => face("room", r))}
                    {!sheet.own.length && sheet.finisher && (
                      <button type="button" className="kg-face kg-face-make" disabled={busy} aria-label={`Make a ${sheet.finisher.name} from this session`} title={[sheet.finisher.tool === "claude" ? "Claude Code" : sheet.finisher.tool, sheet.finisher.projects?.[0]].filter(Boolean).join(" · ")} onClick={() => void makeFinisher()}>
                        <span className="kg-face-mark">
                          <Icon name="plus" size={16} />
                        </span>
                        <span className="kg-face-name">Make a {sheet.finisher.name}</span>
                      </button>
                    )}
                  </div>
                )}
                {pickLine && <p className="kg-pick-line">{pickLine}</p>}
              </div>
              <textarea className="kg-note" aria-label="A line of your own" rows={3} value={note} placeholder={toName ? `What should ${toName} do?` : "What to do first"} onChange={(e) => setNote(e.target.value)} />
              <div className="kg-sec" role="group" aria-label="What goes with it">
                <span className="kg-label">Takes with it</span>
                <div className="kg-chips">
                  {rows.map((r) => (
                    <button key={r.key} type="button" role="checkbox" aria-checked={carry[r.key]} aria-label={r.line} title={r.line} className="kg-chip kg-carry" onClick={() => setCarry((c) => ({ ...c, [r.key]: !c[r.key] }))}>
                      {carry[r.key] && <CheckIcon className="size-3" aria-hidden="true" />}
                      {CARRY_SHORT[r.key](r.line)}
                    </button>
                  ))}
                </div>
              </div>
              {pick?.kind === "own" && (
                <div className="kg-asks">
                  <Icon name="shield" size={14} className="kg-asks-mark" />
                  <span className="kg-asks-line">{asksLine}</span>
                  <button type="button" className="kg-link" aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
                    {asking ? "Done" : "Change"}
                  </button>
                  {asking && (
                    <div className="kg-chips kg-asks-chips" role="group" aria-label="Ask me before">
                      {ASK_KEYS.map((k) => (
                        <button key={k} type="button" className="kg-chip" aria-pressed={asks.has(k)} onClick={() => setAsks((a) => ((n) => (n.has(k) ? n.delete(k) : n.add(k), n))(new Set(a)))}>
                          {ASK_WORDS[k]}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
          {err && (
            <p className="kg-err" role="alert">
              {err}
            </p>
          )}
          <DialogFooter className="kg-foot">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!chosen || busy || !!sheet?.handed}>
              {chosen ? `Hand to ${toName}` : "Hand it on"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Typing in a lane a crew mate has: take it back, or send it a note. */
export function WheelDialog({ ask, onClose }: { ask: { sid: string; invite: string; job: string; mateName: string; text: string }; onClose: (a: "back" | "note" | null) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async (how: "back" | "note") => {
    setBusy(true);
    try {
      if (how === "back") (await workReq(kgPath(ask.sid, ask.invite, `/${ask.job}/back`), { method: "POST", body: JSON.stringify({ how: "back" }) }), dispatchEvent(new Event("friday:attention")));
      else await workReq(kgPath(ask.sid, ask.invite, `/${ask.job}/note`), { method: "POST", body: JSON.stringify({ text: ask.text }) });
      if (how === "note") notice(`Sent to ${ask.mateName}.`);
      onClose(how);
    } catch (e) {
      notice((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose(null)}>
      <DialogContent className="kg-wheel sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{ask.mateName} is on this</DialogTitle>
          <DialogDescription>Take it back and carry on yourself, or send {ask.mateName} what you wrote.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void go("back")}>
            Take it back
          </Button>
          <Button type="button" disabled={busy} onClick={() => void go("note")}>
            Send {ask.mateName} a note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type Piece = { key: string; from: string; what: string; at: number; branch?: string; files: string[]; repo?: string; relation: "handed" | "same" | "unknown" | "other"; skip?: string; conflicts: string[]; who?: { name: string; look?: string } };
const RELATION: Record<Piece["relation"], string> = { handed: "Handed from here", same: "Same repo", unknown: "", other: "Another repo" };
const ago = (t: number) => ((m) => (m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`))(Math.round((Date.now() - t) / 60_000));

/**
 * A look before work comes in (Arun, 2026-11-13: "we need to make this smart and ensure other conflicting stuff isnt being brought
 * over"): each finished piece of a crew mate's or a room's work, the most related first (handed from here, then the same repo; another
 * repo is left out unless asked), the files changed here too, and the files to bring, all ticked. This session's agent merges what
 * is picked and checks it.
 */
export function BringSheet({ ask, onClose }: { ask: BringAsk; onClose: () => void }) {
  const [plan, setPlan] = useState<{ pieces: Piece[]; here: { repo?: string; title: string } } | null>(null);
  const [err, setErr] = useState("");
  // Several at once (Arun, 2026-11-13: "be able to check multiple too").
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<Set<string>>(new Set());
  const [showFiles, setShowFiles] = useState(false);
  const [anyway, setAnyway] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const path = kgPath(ask.sid, ask.invite, "", `&bringFrom=${encodeURIComponent(ask.from)}`);
  useEffect(() => {
    void workReq<{ pieces: Piece[]; here: { repo?: string; title: string } }>(path).then(
      (p) => {
        setPlan(p);
        // Everything at once: what was handed from here comes ticked, all of it; otherwise the first that fits.
        const handed = ask.from === "all" ? p.pieces.filter((x) => x.relation === "handed" && !x.skip) : [];
        const first = p.pieces.find((x) => !x.skip) ?? p.pieces[0];
        if (handed.length > 1) setPicks(new Set(handed.map((x) => x.key)));
        else if (handed[0] ?? first) ((x) => (setPicks(new Set([x.key])), setFiles(new Set(x.files))))((handed[0] ?? first)!);
      },
      (e: Error) => setErr(e.message),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = (plan?.pieces ?? []).filter((p) => picks.has(p.key));
  const one = chosen.length === 1 ? chosen[0]! : null;
  const flip = (p: Piece) =>
    setPicks((s) => {
      const n = new Set(s);
      if (n.has(p.key)) n.delete(p.key);
      else n.add(p.key);
      const only = (plan?.pieces ?? []).filter((x) => n.has(x.key));
      if (only.length === 1) setFiles(new Set(only[0]!.files));
      return n;
    });
  const skipped = chosen.some((p) => p.skip);
  const go = async () => {
    if (!chosen.length || busy) return;
    setBusy(true);
    try {
      await workReq(path, { method: "POST", body: JSON.stringify({ keys: chosen.map((p) => p.key), ...(one ? { files: [...files] } : {}), note, ...(skipped ? { anyway } : {}) }) });
      dispatchEvent(new Event("friday:bring-done"));
      notice(chosen.length > 1 ? `Bringing in ${chosen.length} pieces. This session's agent is merging them and checking them.` : "Bringing it in. This session's agent is merging it and checking it.");
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  const blocked = !chosen.length || (!!one && one.files.length > 0 && files.size === 0) || (skipped && !anyway);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="kg-sheet kg-bring-sheet sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Bring in work from {ask.name}</DialogTitle>
          <DialogDescription className="sr-only">Tick what comes into this session. Your agent merges it, checks it and carries on.</DialogDescription>
        </DialogHeader>
        {!plan && !err && <p className="kg-hint">Looking at what {ask.name} finished…</p>}
        {plan && !plan.pieces.length && <p className="kg-hint">{ask.from === "all" ? "Nothing new from your crew to bring in." : `Nothing new from ${ask.name} to bring in.`}</p>}
        {plan && plan.pieces.length > 0 && (
          <div className="kg-sec kg-pieces" role="group" aria-label="What to bring in">
            {plan.pieces.map((p) => {
              const on = picks.has(p.key);
              return (
                <button key={p.key} type="button" role="checkbox" aria-checked={on} className="kg-piece" data-on={on || undefined} data-skip={p.skip ? "" : undefined} onClick={() => flip(p)}>
                  <span className="kg-piece-box" aria-hidden="true">
                    {on && <CheckIcon className="size-3" />}
                  </span>
                  <span className="kg-piece-main">
                    <span className="kg-piece-top">
                      {p.who && <Face seed={p.who.look ?? p.who.name} size={16} />}
                      <span className="kg-piece-what" title={p.what}>{p.what || "Finished work"}</span>
                      {RELATION[p.relation] && <span className="kg-piece-tag" data-rel={p.relation}>{RELATION[p.relation]}</span>}
                    </span>
                    <span className="kg-piece-sub">{[p.from, ago(p.at), p.branch, p.files.length ? `${p.files.length} file${p.files.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}</span>
                    {p.conflicts.length > 0 && <span className="kg-piece-warn">{p.conflicts.length} file{p.conflicts.length === 1 ? "" : "s"} changed here too</span>}
                    {p.skip && <span className="kg-piece-skip">Another repo</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {skipped && (
          <label className="kg-check">
            <input type="checkbox" checked={anyway} onChange={(e) => setAnyway(e.target.checked)} />
            <span>Bring it in though it's from another repo</span>
          </label>
        )}
        {one && one.files.length > 0 && (
          <div className="kg-sec">
            <button type="button" className="kg-link kg-files-toggle" aria-expanded={showFiles} onClick={() => setShowFiles((v) => !v)}>
              {files.size === one.files.length ? `All ${one.files.length} files` : `${files.size} of ${one.files.length} files`}
              {showFiles ? " · hide" : " · choose"}
            </button>
            {showFiles && (
              <div className="kg-files">
                {one.files.map((f) => (
                  <label key={f} className="kg-check kg-file">
                    <input type="checkbox" checked={files.has(f)} onChange={(e) => setFiles((s) => ((n) => (e.target.checked ? n.add(f) : n.delete(f), n))(new Set(s)))} />
                    <code>{f}</code>
                    {one.conflicts.includes(f) && <span className="kg-piece-warn">changed here too</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        {chosen.length > 0 && <textarea className="kg-note" aria-label="A line for your agent" rows={2} value={note} placeholder="Anything to tell your agent (optional)" onChange={(e) => setNote(e.target.value)} />}
        {err && (
          <p className="kg-err" role="alert">
            {err}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={blocked || busy} onClick={() => void go()}>
            {chosen.length > 1 ? `Bring in ${chosen.length}` : "Bring it in"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
