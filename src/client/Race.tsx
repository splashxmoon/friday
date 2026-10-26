import { useMemo, useRef, useState } from "react";
import { commandFailed, receiptOf, type Receipt } from "../receipt.js";
import { scoreMany, type Racer as Attempt } from "../race-score.js";
import { usageReport } from "../usage-report.js";
import { MAIN_LANE, ENGINE_NAMES, ENGINE_MODEL_INFO, type DiffFile, type EngineTool, type SessionEvent } from "../types.js";
import { runOf, type SessionState } from "../session/projection.js";
import type { Member } from "../types.js";
import { Icon } from "./icons.js";
import { patchLines } from "./patchLines.js";
import { DiffView } from "./DiffView.js";
import { hostApi, useMachine } from "./local.js";
import { ShipDialog } from "./Ship.js";
import type { Identity } from "./storage.js";
import { useDismiss } from "./ui.js";
import type { Send } from "./useSession.js";

/**
 * Several agents, one prompt, side by side.
 *
 * "Which agent should we use?" is usually answered by opinion. This answers it
 * with the team's own task: the same instruction goes to two to five agents at
 * once (any tool, any of its models), each in a checkout of its own so they
 * cannot overwrite each other, and what comes back is laid next to each other
 * with the same evidence for all — what changed, what ran, whether the tests
 * passed. Keeping one throws the others' checkouts away (Arun, 2026-10-25: one
 * prompt to several agents, compare, keep the winner).
 */

/** A racing lane is named like this, so the session needs no new field to know about it. */
export const RACE_PREFIX = "Race · ";

type Racer = "friday" | EngineTool;
const label = (r: Racer) => (r === "friday" ? "Friday Code" : ENGINE_NAMES[r]);
/** The most agents in one race: each is a copy of the folder and a tool running, and five columns is what a screen reads. */
export const MAX_RACERS = 5;
const LETTERS = ["A", "B", "C", "D", "E"];
/** One racer as the dialog holds it: the tool, and one of its models when the person picked one ("" is the tool's own default). */
interface Pick {
  tool: Racer;
  model: string;
}
const modelsOf = (r: Racer) => (r === "friday" ? [] : (ENGINE_MODEL_INFO[r] ?? []).filter((m) => m.group !== "Auto"));
const modelLabel = (r: Racer, id: string) => modelsOf(r).find((m) => m.id === id)?.label ?? id;

export function raceLanes(state: SessionState): { id: string; name: string }[] {
  return state.lanes.filter((l) => l.name.startsWith(RACE_PREFIX)).map((l) => ({ id: l.id, name: l.name }));
}

/** Whether there is somewhere to race: one of my own machine's folders, in a git repository. */
export function raceBase(state: SessionState, me: Member) {
  const e = state.engines[MAIN_LANE];
  return e?.online && e.hostId === me.id && e.branch ? e : null;
}

export function RaceDialog({ state, me, identity, sid, invite, send, onClose, solo = false }: { state: SessionState; me: Member; identity: Identity; sid: string; invite: string; send: Send; onClose: () => void; /** Solo: Friday Code isn't one of the racers. */ solo?: boolean }) {
  const ref = useRef<HTMLFormElement>(null);
  useDismiss(ref, onClose);
  const { state: machine } = useMachine(identity);
  const base = raceBase(state, me);
  // On Solo Friday's agent is Team's, so it isn't offered: picked by default for the second racer, half the race was refused.
  const tools = machine.tools.filter((t) => t.path && t.loggedIn !== false).map((t) => t.tool);
  const options: Racer[] = solo ? tools : ["friday", ...tools];
  const [racers, setRacers] = useState<Pick[]>(() => [
    { tool: solo ? (tools[0] ?? "claude") : (options[1] ?? "friday"), model: "" },
    { tool: solo ? (tools[1] ?? tools[0] ?? "claude") : (options[2] ?? "friday"), model: "" },
  ]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The same agent twice is a fair race too — a model against itself shows how steady it is, and one tool's models against each other
  // is the race people most want to run.
  const can = !!base && !!text.trim() && !busy;
  const setRacer = (i: number, next: Partial<Pick>) => setRacers((rs) => rs.map((r, j) => (j === i ? { ...r, ...next } : r)));

  const start = async () => {
    if (!base || !can) return;
    setBusy(true);
    setError("");
    const launched: { lane: string; cwd?: string }[] = [];
    try {
      for (const [i, r] of racers.entries()) {
        const res = await hostApi<{ lane: string }>(identity, "/api/runner/start", {
          method: "POST",
          body: JSON.stringify({
            sid,
            invite,
            ...(r.tool === "friday" ? {} : { tool: r.tool }),
            ...(r.model ? { model: r.model } : {}),
            cwd: base.cwd,
            // Free to run the tests: that is half of what there is to compare, and it is a copy.
            mode: "full",
            worktree: true,
            newLane: `${RACE_PREFIX}${LETTERS[i]} · ${label(r.tool)}${r.model ? ` · ${modelLabel(r.tool, r.model)}` : ""}`,
          }),
        });
        launched.push({ lane: res.lane });
      }
      for (const l of launched) {
        const r = await send({ type: "instruct", text: text.trim(), lane: l.lane });
        if (!r.ok) throw new Error(r.error ?? "It wouldn't take the instruction.");
      }
      onClose();
    } catch (e) {
      // Half a race is not a race: take back whatever did start.
      for (const l of launched) {
        await hostApi(identity, "/api/runner/stop", { method: "POST", body: JSON.stringify({ sid, lane: l.lane }) }).catch(() => {});
        await send({ type: "lane.remove", laneId: l.lane }).catch(() => {});
      }
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const pick = (r: Pick, i: number) => {
    const models = modelsOf(r.tool);
    return (
      <div className="race-racer" key={i}>
        <label className="field">
          <span>Agent {LETTERS[i]}</span>
          <select value={r.tool} onChange={(e) => setRacer(i, { tool: e.target.value as Racer, model: "" })}>
            {options.map((o) => (
              <option key={o} value={o}>
                {label(o)}
              </option>
            ))}
          </select>
        </label>
        {models.length > 0 && (
          <label className="field">
            <span>Model</span>
            <select value={r.model} onChange={(e) => setRacer(i, { model: e.target.value })}>
              <option value="">Its default</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {racers.length > 2 && (
          <button type="button" className="icon-btn tiny race-racer-drop" aria-label={`Drop agent ${LETTERS[i]}`} onClick={() => setRacers((rs) => rs.filter((_, j) => j !== i))}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="overlay">
      <form
        ref={ref}
        className="modal manual-form race-modal"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="pop-head">
          <div>
            <h2>Race agents</h2>
            <p className="muted small">Same task to each, in its own copy of {base ? <code>{base.cwd.split(/[\\/]/).pop()}</code> : "your folder"}. Compare what comes back and keep the one you like.</p>
          </div>
          <button className="icon-btn tiny" type="button" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        {!base && <p className="form-error">Connect a machine with a git folder to this session first. Each agent needs its own copy of the code to work in.</p>}
        <div className="race-pick">
          {racers.map(pick)}
          {racers.length < MAX_RACERS && (
            <button type="button" className="btn ghost small race-add" onClick={() => setRacers((rs) => [...rs, { tool: rs.at(-1)!.tool, model: "" }])}>
              <Icon name="plus" size={13} /> Add an agent
            </button>
          )}
        </div>
        <label className="field">
          <span>The task</span>
          <textarea rows={4} autoFocus value={text} placeholder="Move the settings screen onto the theme tokens, and keep the tests passing." onChange={(e) => setText(e.target.value)} />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!can}>
            {busy ? "Starting…" : "Start the race"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** One lane's own calls, answers and diff, read the same way the review card reads a run. */
function laneReceipt(events: SessionEvent[], state: SessionState, lane: string): Receipt {
  const failed = new Map<string, boolean | null>();
  for (const e of events) if (e.body.type === "tool.result" && (e.lane ?? MAIN_LANE) === lane) failed.set(e.body.callId, commandFailed(e.body));
  const calls = [];
  let answer = "";
  for (const e of events) {
    if (e.body.type !== "agent.message" || (e.lane ?? MAIN_LANE) !== lane) continue;
    calls.push(...e.body.toolCalls);
    if (!e.body.toolCalls.length && e.body.text) answer = e.body.text;
  }
  return receiptOf({ calls, failed: (id) => (failed.has(id) ? failed.get(id)! : null), files: state.diffs[lane]?.files ?? [], answer });
}

const STATUS: Record<string, string> = { idle: "Finished", running: "Working", paused: "Paused", waiting_for_human: "Needs you", error: "Stopped" };

export function RaceCard({ state, me, events, identity, sid, invite, send }: { state: SessionState; me: Member; events: SessionEvent[]; identity: Identity; sid: string; invite: string; send: Send }) {
  const lanes = raceLanes(state);
  const [shipping, setShipping] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = useMemo(
    () => lanes.map((l) => ({ ...l, receipt: laneReceipt(events, state, l.id), run: runOf(state, l.id), files: state.diffs[l.id]?.files ?? [] })),
    // The log only grows, so its length is all that tells the receipts they are stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events.length, state.lanes, state.laneRuns, state.diffs],
  );
  // The finished attempts, compared on what can be counted: tests, size, time, tokens. See race-score.ts for what it will and will not claim.
  const attempts = useMemo(() => {
    if (rows.length < 2) return null;
    const live = new Set(rows.filter((r) => r.run.status === "running").map((r) => r.id));
    const used = usageReport(events, (l) => l, live);
    const racer = (r: (typeof rows)[number]): Attempt => {
      const u = used.byAgent.find((x) => x.key === r.id);
      return {
        id: r.id,
        name: r.name.slice(RACE_PREFIX.length),
        tests: r.receipt.tests,
        red: r.receipt.flags.filter((f) => f.level === "bad").length,
        files: r.files.length,
        added: r.files.reduce((n, f) => n + f.additions, 0),
        removed: r.files.reduce((n, f) => n + f.deletions, 0),
        seconds: u?.seconds ?? 0,
        tokens: u?.counted ? u.tokens : null,
        commands: r.receipt.commands.length,
        finished: r.run.status !== "running" && (u?.runs ?? 0) > 0,
      };
    };
    return rows.map(racer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, events.length]);
  const scored = useMemo(() => (attempts ? scoreMany(attempts) : null), [attempts]);
  // Keeping one removes the other's lane, which leaves one: the commit dialog
  // it opens has to outlive the card.
  const dialog = shipping ? <ShipDialog state={state} sid={sid} invite={invite} send={send} lane={shipping} onClose={() => setShipping(null)} /> : null;
  if (lanes.length < 2) return dialog;
  const owner = me.role === "owner";
  const running = rows.some((r) => r.run.status === "running");

  /** Throw away a racer: stop it, delete its copy, and take its lane out of the session. */
  const discard = async (lane: string) => {
    const cwd = state.engines[lane]?.cwd;
    await hostApi(identity, "/api/runner/stop", { method: "POST", body: JSON.stringify({ sid, lane }) }).catch(() => {});
    if (cwd) await hostApi(identity, "/api/runner/worktree.drop", { method: "POST", body: JSON.stringify({ path: cwd }) }).catch(() => {});
    await send({ type: "lane.remove", laneId: lane });
  };

  const keep = async (lane: string) => {
    setBusy(true);
    try {
      for (const r of rows) if (r.id !== lane) await discard(r.id);
      setShipping(lane);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="race" aria-label="Race">
      <header className="race-head">
        <span className="race-title">
          <Icon name="zap" size={13} /> Race
        </span>
        <span className="muted small">{running ? `${rows.length === 2 ? "Both" : `All ${rows.length}`} are working on the same task.` : `${rows.length === 2 ? "Both have" : "All have"} finished. Pick one to keep.`}</span>
        {owner && (
          <button type="button" className="btn ghost small race-end" disabled={busy} onClick={() => void Promise.all(rows.map((r) => discard(r.id)))}>
            End race
          </button>
        )}
      </header>
      <div className="race-cols" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
        {rows.map((r) => {
          const adds = r.files.reduce((n, f) => n + f.additions, 0);
          const dels = r.files.reduce((n, f) => n + f.deletions, 0);
          const bad = r.receipt.flags.some((f) => f.level === "bad");
          const leans = scored?.lean === r.id;
          return (
            <div key={r.id} className={`race-col ${bad ? "bad" : ""}${leans ? " lean" : ""}`}>
              <div className="race-col-head">
                <b>{r.name.slice(RACE_PREFIX.length)}</b>
                {leans ? <span className="race-lean-chip"><Icon name="check" size={11} /> Leans this way</span> : <span className={`race-status ${r.run.status}`}>{STATUS[r.run.status] ?? r.run.status}</span>}
              </div>
              <div className="race-facts">
                <span>
                  {r.files.length} file{r.files.length === 1 ? "" : "s"} <b className="diff-add">+{adds}</b> <b className="diff-del">−{dels}</b>
                </span>
                <span className={`review-tests ${r.receipt.tests === "none" ? "none" : r.receipt.tests}`}>{r.receipt.tests === "pass" ? "Tests passed" : r.receipt.tests === "fail" ? "Tests failed" : "Tests not run"}</span>
                <span className="muted">{r.receipt.commands.length} command{r.receipt.commands.length === 1 ? "" : "s"} ran</span>
              </div>
              {r.receipt.flags.map((f) => (
                <div key={f.text} className={`receipt-flag ${f.level}`}>
                  <Icon name={f.level === "bad" ? "x" : "help"} size={13} /> {f.text}
                </div>
              ))}
              {r.files.length > 0 && <div className="race-files">{r.files.slice(0, 4).map((f) => f.path).join(", ")}{r.files.length > 4 ? ` +${r.files.length - 4}` : ""}</div>}
              <button
                type="button"
                className="btn primary small"
                disabled={!owner || busy || r.run.status === "running"}
                title={!owner ? "Only an owner can choose" : r.run.status === "running" ? "Let it finish first" : `Keep this one and throw the other${rows.length > 2 ? "s" : ""} away`}
                onClick={() => void keep(r.id)}
              >
                <Icon name="check" size={13} /> {bad ? "Keep anyway" : "Keep this one"}
              </button>
            </div>
          );
        })}
      </div>
      {scored && attempts && (
        <div className="race-compare" role="table" aria-label="How they compare" style={{ "--racers": attempts.length } as React.CSSProperties}>
          <div className="race-compare-head" role="row">
            <span />
            {attempts.map((a) => (
              <b key={a.id} role="columnheader">
                {a.name}
              </b>
            ))}
          </div>
          {scored.rows.map((x) => (
            <div key={x.key} className="race-compare-row" role="row">
              <span className="race-compare-label" role="rowheader">
                {x.label}
              </span>
              {x.values.map((v, i) => (
                <span key={i} role="cell" className={x.best.includes(i) ? "better" : ""}>
                  {v}
                </span>
              ))}
            </div>
          ))}
          <p className={`race-verdict ${scored.lean ? "leans" : ""}`}>{scored.lean ? <Icon name="check" size={13} /> : null} {scored.why}</p>
        </div>
      )}
      {rows.length >= 2 && !running && <RaceChanges racers={rows} />}
      {dialog}
    </section>
  );
}

/**
 * The attempts' changes, file by file, next to each other: the comparison a person makes before keeping one, which the numbers
 * above can't. Files more of them changed come first, since that is where they disagree.
 */
function RaceChanges({ racers }: { racers: { name: string; files: DiffFile[] }[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const names = racers.map((r) => r.name.slice(RACE_PREFIX.length));
  const byPath = new Map<string, (DiffFile | undefined)[]>();
  racers.forEach((r, i) => {
    for (const f of r.files) {
      const row = byPath.get(f.path) ?? new Array<DiffFile | undefined>(racers.length).fill(undefined);
      row[i] = f;
      byPath.set(f.path, row);
    }
  });
  const count = (p: string) => byPath.get(p)!.filter(Boolean).length;
  const paths = [...byPath.keys()].sort((x, y) => count(y) - count(x) || x.localeCompare(y));
  if (!paths.length) return null;
  const who = (row: (DiffFile | undefined)[]) => {
    const did = names.filter((_, i) => row[i]);
    if (did.length === racers.length) return racers.length === 2 ? "Both changed it" : "All changed it";
    if (did.length === 1) return `Only ${did[0]}`;
    return `${did.slice(0, -1).join(", ")} and ${did.at(-1)} changed it`;
  };
  const side = (f: DiffFile | undefined, name: string) =>
    f ? <DiffView path={f.path} lines={patchLines(f.patch)} defaultOpen maxHeight={360} {...(f.truncated ? { status: "cut short" } : {})} /> : <div className="race-diff-none muted small">{name} left this file alone.</div>;
  return (
    <div className="race-changes">
      <div className="race-changes-head">
        <b>Compare the changes</b>
        <span className="muted small">{paths.length} file{paths.length === 1 ? "" : "s"} · open one to read every version side by side</span>
      </div>
      <ul className="race-changes-list">
        {paths.map((p) => {
          const row = byPath.get(p)!;
          const on = open === p;
          return (
            <li key={p}>
              <button type="button" className={`race-file ${on ? "on" : ""}`} aria-expanded={on} onClick={() => setOpen(on ? null : p)}>
                <Icon name="file" size={13} />
                <span className="race-file-path">{p}</span>
                <span className="race-file-who">{who(row)}</span>
                <Icon name={on ? "chevronUp" : "chevronDown"} size={12} />
              </button>
              {on && (
                <div className="race-diff-pair" style={{ gridTemplateColumns: `repeat(${racers.length}, minmax(0, 1fr))` }}>
                  {row.map((f, i) => (
                    <div key={i} className="race-diff-col">
                      <div className="race-diff-name">{names[i]}</div>
                      {side(f, names[i]!)}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
