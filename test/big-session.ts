// A long session made up for a spec (spec 13: "a 20,000-event session opens with its last rows visible"), written straight into a
// fresh data folder before Friday starts on it, the way the open-source edition keeps one (src/local/kv.ts): data.json names the
// session's keys, and its log is a file of its own under logs/, an event a line. Several agents each with a change set of a few
// dozen files that grows a file a turn, kept as the store keeps them (session/patches.ts refPatches): a patch the lane's last
// change set already held is a reference to where it is kept. Nothing in it is anyone's real work. Here, not in e2e/, so the speed
// check that ships with the open-source edition (test/speed-budget.test.ts) makes the same one; e2e/big-session.ts hands it on.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BigSession {
  sid: string;
  events: number;
  /** The lanes it has, the main one first. */
  lanes: string[];
}

const PREFIX = "friday:";
const logFile = (k: string) => path.join("logs", `${createHash("sha256").update(k).digest("hex").slice(0, 32)}.jsonl`);
const WORDS = "the a to of and in is it that for on with as this file test run src const function return error build agent page row".split(" ");

export async function seedBigSession(home: string, o: { events?: number; lanes?: number; files?: number; patchLines?: number; sid?: string } = {}): Promise<BigSession> {
  const sid = o.sid ?? "bigSess1";
  const N = o.events ?? 20_000;
  const laneIds = ["main", ...Array.from({ length: (o.lanes ?? 4) - 1 }, (_, i) => `lane${i + 1}`)];
  const FILES = o.files ?? 60;
  const LINES = o.patchLines ?? 80;
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const text = (n: number) => {
    let s = "";
    while (s.length < n) s += WORDS[Math.floor(rnd() * WORDS.length)] + (rnd() < 0.08 ? ".\n\n" : " ");
    return s.slice(0, n);
  };
  const t0 = Date.now() - N * 2_000;
  const you = { id: "local", name: "You", kind: "human" };
  const bot = { id: "agent", name: "Agent", kind: "agent" };
  const lines: string[] = [];
  let seq = 0;
  const push = (actor: object, body: Record<string, unknown>, lane?: string) => {
    seq++;
    lines.push(JSON.stringify(JSON.stringify({ seq, ts: t0 + seq * 2_000, actor, body, ...(lane && lane !== "main" ? { lane } : {}) })));
    return seq;
  };
  push({ id: "system", name: "System", kind: "system" }, { type: "session.created", title: "A long session", ownerId: "local", ownerName: "You", workspaceId: "local", options: { webSearch: false, controlMode: "ask", mcp: true, model: "", agent: null } });
  for (const id of laneIds.slice(1)) push(you, { type: "lane.added", lane: { id, name: `Agent ${id.slice(4)}`, agent: null, control: { kind: "open" }, controlMode: "ask", trigger: { kind: "manual" } } });
  /** Each lane's change set as it stands: per file, its patch and the seq of the change set that holds that text. */
  const sets = new Map(laneIds.map((l) => [l, new Map<string, { patch: string; additions: number; at: number }>()]));
  const patchOf = (file: string, turn: number) => {
    const n = 3 + Math.floor(rnd() * LINES);
    let p = `@@ -1,3 +1,${n} @@ turn ${turn}\n ${file}\n-old ${turn}\n`;
    for (let i = 0; i < n; i++) p += `+${text(60).replace(/\n+/g, " ")}\n`;
    return { patch: p, additions: n };
  };
  for (let turn = 0; seq < N - 8; turn++) {
    const lane = laneIds[turn % laneIds.length]!;
    const asked = push(you, { type: "instruction", text: `Step ${turn}: ${text(120)}`, interrupt: false }, lane);
    push(bot, { type: "run.started", causedBy: asked, checkpoint: createHash("sha1").update(`${lane}:${turn}`).digest("hex") }, lane);
    push(bot, { type: "instructions.delivered", seqs: [asked] }, lane);
    push(bot, { type: "agent.message", text: text(200), toolCalls: [{ id: `c${turn}`, name: "bash", arguments: JSON.stringify({ command: `npm test -- src/${turn % 40}` }) }] }, lane);
    push(bot, { type: "tool.result", callId: `c${turn}`, name: "bash", output: text(1_200), isError: false }, lane);
    push(bot, { type: "agent.message", text: text(400), toolCalls: [] }, lane);
    // The change set: every file the lane has changed so far, one of them changed again this turn.
    const set = sets.get(lane)!;
    const changed = `src/${lane}/file${Math.floor(turn / laneIds.length) % FILES}.ts`;
    const diffSeq = seq + 1;
    set.set(changed, { ...patchOf(changed, turn), at: diffSeq });
    const files = [...set.entries()].map(([p, f]) => ({ path: p, status: "modified", additions: f.additions, deletions: 1, patch: f.at === diffSeq ? f.patch : "", ...(f.at === diffSeq ? {} : { at: f.at }) }));
    push(bot, { type: "agent.diff", base: "0000000", files }, lane);
    push(bot, { type: "run.ended", outcome: "done", after: createHash("sha1").update(`${lane}:${turn}:after`).digest("hex") }, lane);
  }
  const k = (s: string) => `${PREFIX}{${sid}}:${s}`;
  const events = k("events");
  await mkdir(path.join(home, "logs"), { recursive: true });
  await writeFile(path.join(home, logFile(events)), lines.join("\n") + "\n");
  const rows = [
    { k: `${PREFIX}mine:local`, t: "zset", v: [sid, String(Date.now())] },
    { k: k("control"), t: "hash", v: { "driver:main": "local", "driverName:main": "You" } },
    { k: events, t: "list", v: [], file: logFile(events) },
    // The secret shield has read it all: nothing in it to hide.
    { k: k("shielded"), t: "string", v: String(seq) },
  ];
  await writeFile(path.join(home, "data.json"), JSON.stringify(rows));
  return { sid, events: seq, lanes: laneIds };
}
