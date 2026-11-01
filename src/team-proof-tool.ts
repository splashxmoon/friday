import { laneName } from "./session/core.js";
import type { SessionState } from "./session/projection.js";
import { MAIN_LANE, type ActorRef, type EventBody, type SessionEvent } from "./types.js";

/**
 * post_proof and the picture that comes with it, on the server (team-proof.ts reads proof from the log, for the app and the
 * server alike): the teammate's review of its work kept with the task it has or its run, and the page's picture its runner took.
 */

/** post_proof: the teammate's proof, as the friday MCP server offers it next to finish_task. */
export const PROOF_TOOL = {
  name: "post_proof",
  description:
    "Hand in proof of your work, the last step before finish_task (or before you end a turn that did what was asked): what you did, what you checked and how (the commands you ran and what they showed), and what is still uncertain or untested. The person and whoever reviews it read this first, instead of your log. Where the work has a page (a UI you changed and a dev server running on localhost), give its address as page: Friday keeps a picture of it with the proof. Friday adds the files you changed and the checks it ran itself. Plain sentences, no markdown.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "The board task it is for; leave out for the one you have, or for work that isn't on the board." },
      done: { type: "string", description: "What you did, one to three sentences." },
      checked: { type: "string", description: "What you checked and how: commands run and what they showed, pages looked at." },
      unsure: { type: "string", description: "What is still uncertain, untested or left for someone else; \"Nothing\" when nothing is." },
      page: { type: "string", description: "The page the change touched, on this machine: http://localhost:5173/settings, or a port." },
    },
    required: ["done", "checked", "unsure"],
    additionalProperties: false,
  },
  annotations: { destructiveHint: false, openWorldHint: false },
};

/** The largest picture kept with a proof. */
export const PROOF_SHOT_MAX = 8 << 20;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const laneOfEvent = (e: SessionEvent) => e.lane ?? MAIN_LANE;

/** The board task a lane has now, or had last: what post_proof without an id is for. */
function laneTask(state: SessionState, lane: string): string | undefined {
  const mine = (state.board?.tasks ?? []).filter((t) => t.lane === lane && t.status !== "open" && t.status !== "cancelled");
  return (mine.find((t) => t.status === "claimed") ?? mine.find((t) => t.status === "review" || t.status === "blocked"))?.id;
}

export interface ProofStore {
  state(sid: string): Promise<SessionState>;
  events(sid: string): Promise<SessionEvent[]>;
  append(sid: string, actor: ActorRef, body: EventBody, opts?: { lane?: string }): Promise<unknown>;
}

/** What the runner is asked to capture with a proof that names a page (agent-mesh PreviewCapture). */
export interface ProofCapture {
  url: string;
  width: number;
  height: number;
  fullPage: boolean;
}

/**
 * post_proof from a teammate: its review kept with the task it has (or its run), and, for a page, the picture asked of the runner
 * on its computer (runner/proof-shot.ts sends it back as __proof_shot). `page` is checked by `local` (agent-mesh localPage).
 */
export async function postProof(store: ProofStore, sid: string, lane: string, args: Record<string, unknown>, local: (raw: unknown) => { ok: true; url: string } | { ok: false; error: string }): Promise<{ output: string; isError?: boolean; capture?: ProofCapture }> {
  const done = str(args.done).trim();
  const checked = str(args.checked).trim();
  const unsure = str(args.unsure).trim();
  if (!done || !checked) return { output: "Say what you did (done) and what you checked (checked), and what is still uncertain (unsure).", isError: true };
  const state = await store.state(sid);
  const asked = str(args.id).trim().toLowerCase();
  const task = asked ? state.board?.tasks.find((t) => t.id === asked) : undefined;
  if (asked && !task) return { output: `There's no task "${asked}" on the board. Leave id out for work that isn't on it.`, isError: true };
  if (task && task.lane !== lane) return { output: `Task "${task.id}" isn't yours: post proof for your own work.`, isError: true };
  const id = task?.id ?? laneTask(state, lane);
  let page: string | undefined;
  if (str(args.page).trim()) {
    const u = local(args.page);
    if (!u.ok) return { output: u.error.replace("{what}", "can be pictured with a proof"), isError: true };
    page = u.url;
  }
  const name = laneName(state, lane);
  await store.append(sid, { id: "agent", name, kind: "agent" }, { type: "proof.posted", ...(id ? { id } : {}), done: done.slice(0, 1200), checked: checked.slice(0, 1200), unsure: (unsure || "Nothing said.").slice(0, 1200), ...(page ? { page } : {}) }, { lane });
  const output = `Proof kept${id ? ` for "${id}"` : ""}; the person and the reviewer read it first.${id && state.board?.tasks.find((t) => t.id === id)?.status === "claimed" ? ` Now finish_task "${id}".` : ""}`;
  if (!page) return { output };
  return { output: `${output} Its picture of ${page} is taken where Friday's desktop app runs; elsewhere the proof keeps the page's address.`, capture: { url: page, width: 1280, height: 800, fullPage: false } };
}

/**
 * The picture a runner took for a proof (__proof_shot): kept as a file of the session, and joined to the lane's latest proof
 * that names a page and has none yet. `save` keeps the file and answers its id.
 */
export async function keepProofShot(store: ProofStore, save: ((sid: string, data: Buffer, type: string) => Promise<string>) | null, sid: string, lane: string, args: Record<string, unknown>): Promise<{ output: string; isError?: boolean }> {
  if (!save) return { output: "Pictures aren't kept here.", isError: true };
  const type = str(args.mimeType) || "image/png";
  if (!/^image\/(png|jpeg|webp)$/.test(type)) return { output: "Only a PNG, JPEG or WebP picture is kept.", isError: true };
  const data = Buffer.from(str(args.data), "base64");
  if (!data.length || data.length > PROOF_SHOT_MAX) return { output: "That picture is empty or too big to keep.", isError: true };
  const events = await store.events(sid);
  const posted = events.findLast((e) => laneOfEvent(e) === lane && e.body.type === "proof.posted");
  if (posted?.body.type !== "proof.posted" || !posted.body.page || events.some((e) => e.seq > posted.seq && e.body.type === "proof.shot" && e.body.proof === posted.seq)) return { output: "No proof is waiting for a picture.", isError: true };
  const file = await save(sid, data, type);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined);
  const name = laneName(await store.state(sid), lane);
  await store.append(sid, { id: "agent", name, kind: "agent" }, { type: "proof.shot", proof: posted.seq, url: posted.body.page, file, ...(n(args.width) ? { width: n(args.width)!, height: n(args.height) ?? 0 } : {}) }, { lane });
  return { output: "Kept with the proof." };
}
