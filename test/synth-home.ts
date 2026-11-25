/**
 * A Friday home with a long history, made up: for measuring how Friday starts and how much memory it holds with one (spec 13,
 * Wave 2 · G), and for Wave 4's speed check (test/speed-budget.test.ts; Arun 2026-11-24: "Go all out and fix these problems").
 * Never a copy of anyone's data. The command is scripts/synth-home.mts.
 *
 * Writes `<home>/data.json` and `<home>/logs/*.jsonl` the way the open-source edition keeps them (src/local/kv.ts): every session
 * in the local person's list, its log in a file of its own. One session is big (`bigEvents` events, about `bigMb` MB, the size of
 * the longest real one seen); the rest share what is left of `mb`, some long, most short. `live: N` leaves the N newest sessions
 * as a restart would find them: a coding tool attached and its run going, from a Friday that is gone. Seeded, so the same options
 * make the same home. Here, not in scripts/, so the tests that ship with the open-source edition can use it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface SynthOptions {
  sessions?: number;
  mb?: number;
  bigEvents?: number;
  bigMb?: number;
  live?: number;
}

export interface SynthHome {
  home: string;
  sessions: number;
  events: number;
  mb: number;
  live: number;
}

/** Throws on a folder that already has a data.json in it. */
export function synthHome(home: string, o: SynthOptions = {}): SynthHome {
  const SESSIONS = o.sessions ?? 300;
  const MB = o.mb ?? 85;
  const BIG_EVENTS = o.bigEvents ?? 20_000;
  const BIG_MB = o.bigMb ?? 30;
  const LIVE = o.live ?? 0;
  if (existsSync(path.join(home, "data.json"))) throw new Error(`${home} already has a data.json: pick an empty folder.`);
  const PREFIX = "friday:";
  const ME = { id: "local", name: "You", kind: "human" as const };
  const VOCAB = "the a to of and in is it that for on with as this file test run src const function return error build agent session lane fix add change line import export value null await async type string number user server client page event log state".split(" ");
  let seed = 13;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const text = (n: number) => {
    let s = "";
    while (s.length < n) s += (rnd() < 0.08 ? String(Math.floor(rnd() * 99999)) : VOCAB[Math.floor(rnd() * VOCAB.length)]) + (rnd() < 0.1 ? ".\n" : " ");
    return s.slice(0, n);
  };
  const logFile = (k: string) => `logs/${createHash("sha256").update(k).digest("hex").slice(0, 32)}.jsonl`;

  type Body = Record<string, unknown> & { type: string };
  /** One session's log: turns of an instruction, a run with commands and their output, and an answer, until about `bytes`. */
  function sessionLog(sid: string, title: string, start: number, bytes: number, events: number | null, live: boolean, cwd: string): string[] {
    const out: string[] = [];
    let size = 0;
    let ts = start;
    const tool = { id: `engine:${ME.id}`, name: "Your Claude Code", kind: "agent" as const };
    const push = (actor: object, body: Body) => {
      ts += 500 + Math.floor(rnd() * 4000);
      const line = JSON.stringify({ seq: out.length + 1, ts, actor, body });
      out.push(line);
      size += line.length + 1;
    };
    push(ME, { type: "session.created", title, ownerId: ME.id, ownerName: ME.name });
    push(ME, { type: "member.joined", role: "owner" });
    push(ME, { type: "engine.attached", engine: { tool: "claude", hostId: ME.id, hostName: ME.name, cwd, mode: "full", node: "gone-node" } });
    // Each event about this long on average, so the count and the size come out together for the big one.
    const each = events ? Math.max(200, Math.floor((bytes / events) * 1.9)) : 1500;
    const more = () => (events ? out.length < events - 6 : size < bytes);
    for (let i = 0; more(); i++) {
      push(ME, { type: "instruction", text: `Step ${i}: ${text(80 + Math.floor(rnd() * 200))}`, interrupt: false });
      const cause = out.length;
      push(tool, { type: "run.started", causedBy: cause });
      push(tool, { type: "instructions.delivered", seqs: [cause] });
      const calls = 1 + Math.floor(rnd() * 3);
      for (let c = 0; c < calls && more(); c++) {
        push(tool, { type: "agent.message", text: text(Math.floor(each * 0.3)), toolCalls: [{ id: `c${i}-${c}`, name: "bash", arguments: JSON.stringify({ command: `npm test -- src/${i}/${c}` }) }] });
        push(tool, { type: "tool.result", callId: `c${i}-${c}`, name: "bash", output: text(Math.floor(each * (0.5 + rnd() * 2))), isError: false });
      }
      push(tool, { type: "agent.message", text: text(Math.floor(each * 0.6)), toolCalls: [] });
      push(tool, { type: "run.ended", outcome: "done" });
    }
    if (live) {
      // Cut off by a restart mid-turn: a message delivered, its run going, the tool still said to be attached.
      push(ME, { type: "instruction", text: "Keep going: finish the migration and run the tests.", interrupt: false });
      const cause = out.length;
      push(tool, { type: "run.started", causedBy: cause });
      push(tool, { type: "instructions.delivered", seqs: [cause] });
    } else push(ME, { type: "engine.detached", reason: "disconnected", tool: "claude" });
    return out;
  }

  mkdirSync(path.join(home, "logs"), { recursive: true, mode: 0o700 });
  const now = Date.now();
  type Row = { k: string; t: string; v: unknown; file?: string; n?: number; b?: number };
  const rows: Row[] = [];
  const mine: string[] = [];
  // The sizes: one big, the rest from a long tail (most a few dozen KB, a few several MB), scaled to what is left.
  const rest = Math.max(0, MB - BIG_MB) * 1048576;
  const weights = Array.from({ length: Math.max(0, SESSIONS - 1) }, () => Math.exp(rnd() * 4.5));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let written = 0;
  let events = 0;
  for (let i = 0; i < SESSIONS; i++) {
    const sid = `synth-${String(i).padStart(4, "0")}`;
    const big = i === Math.floor(SESSIONS / 3);
    const at = now - i * 3_600_000;
    const live = i < LIVE;
    const lines = sessionLog(sid, big ? "The long one" : `Session ${i}`, at - 86_400_000, big ? BIG_MB * 1048576 : Math.floor((rest * weights[i - (i > Math.floor(SESSIONS / 3) ? 1 : 0)]!) / total), big ? BIG_EVENTS : null, live, path.join(home, "..", "work", sid));
    const k = `${PREFIX}{${sid}}:events`;
    // A line each, as the store keeps an entry: the entry (the event's JSON) written as a JSON string.
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(path.join(home, logFile(k)), text, { mode: 0o600 });
    written += Buffer.byteLength(text);
    events += lines.length;
    rows.push({ k, t: "list", v: [], file: logFile(k), n: lines.length, b: Buffer.byteLength(text) });
    // Read for secrets already, as a log Friday wrote itself is.
    rows.push({ k: `${PREFIX}{${sid}}:shielded`, t: "string", v: String(lines.length) });
    rows.push({ k: `${PREFIX}{${sid}}:seen`, t: "hash", v: { [ME.id]: String(lines.length) } });
    mine.push(String(at), sid);
  }
  const zset: string[] = [];
  for (let i = 0; i < mine.length; i += 2) zset.push(mine[i + 1]!, mine[i]!);
  rows.push({ k: `${PREFIX}mine:${ME.id}`, t: "zset", v: zset });
  // Set up already: the welcome done, as on a computer that has used Friday for a while.
  writeFileSync(path.join(home, "data.json"), JSON.stringify(rows), { mode: 0o600 });
  return { home, sessions: SESSIONS, events, mb: Math.round(written / 1048576), live: LIVE };
}
