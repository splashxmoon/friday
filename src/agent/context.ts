import { formatBytes, type ResolvedFile } from "../files.js";
import { ENGINE_NAMES, MAIN_LANE, type Attachment, type PeerNote, type SessionEvent } from "../types.js";
import { withoutRewound } from "../rewind.js";
import { meshHead } from "../mesh-note.js";
import { HIDDEN, SHIELD_NOTE } from "../secrets.js";
import type { ChatMessage, ContentPart } from "./llm.js";
import { answered, peerHead } from "../session-notes-text.js";
export { answered, peerHead } from "../session-notes-text.js";

export interface ContextOptions {
  /** Contents of attachments on delivered instructions, keyed by attachment id. */
  files?: Map<string, ResolvedFile>;
  /** Whether the model can take images. */
  images?: boolean;
  /**
   * Build the context for this lane. Another lane's model turns and tool results
   * are not this agent's history — replaying them makes it "remember" work it
   * never did — so they are dropped, and what they changed is summarised instead.
   */
  lane?: string;
  /**
   * Files another lane has also changed since the last commit, already
   * written out. The only cross-lane thing this agent is told, and told
   * deliberately: lanes share one folder, so a file somebody else is
   * rewriting is the one piece of another lane's business that is squarely
   * this agent's too.
   */
  contended?: string[];
  /**
   * Lanes whose instructions this lane also acts on: the ones it waits on. Every other lane's
   * instructions are not this agent's to follow. Without this, telling one agent to do something
   * told them all, and each lane quietly picked up the others' tasks.
   */
  inherits?: readonly string[];
  /**
   * Rough ceiling on how much of the log is replayed, in characters. A session
   * that runs all day would otherwise grow past the model's window and start
   * failing outright; trimming the oldest turns keeps it answering. What must
   * survive trimming is what the agent saved with `remember`.
   */
  budget?: number;
  /** Durable notes, replayed in full however long the session gets. */
  memory?: { key: string; text: string }[];
}

/** Characters, not tokens: an estimate that never needs a tokenizer. */
const DEFAULT_BUDGET = 320_000;

/**
 * The agent's context window is a projection of the session log, the same way
 * the UI state and the audit trail are. Restarting the runtime, or moving it to
 * another node, rebuilds exactly the same conversation.
 *
 * Two placement rules keep it faithful:
 *  - Instructions enter at their `instructions.delivered` event, i.e. when the
 *    agent actually saw them, not when a human typed them.
 *  - Tool results must directly follow the assistant turn that requested them,
 *    so session notices that land mid-batch (e.g. a pause) are held until the
 *    batch closes. Calls with no recorded result (crash, preemption) get an
 *    explicit placeholder instead of breaking the conversation.
 */
export function buildContext(allEvents: SessionEvent[], opts: ContextOptions = {}): ChatMessage[] {
  const events = withoutRewound(opts.lane ? forLane(allEvents, opts.lane, new Set(opts.inherits ?? [])) : allEvents);
  const bySeq = new Map(events.map((e) => [e.seq, e]));
  const out: ChatMessage[] = [];
  const outstanding = new Set<string>();
  let held: ContentPart[] = [];

  const flushHeld = () => {
    if (!held.length) return;
    const allText = held.every((p) => p.type === "text");
    out.push({ role: "user", content: allText ? held.map((p) => (p as { text: string }).text).join("\n\n") : held });
    held = [];
  };
  const note = (parts: string | ContentPart[]) => {
    held.push(...(typeof parts === "string" ? [{ type: "text" as const, text: parts }] : parts));
    if (outstanding.size === 0) flushHeld();
  };
  const closeOutstanding = (why: string) => {
    for (const id of outstanding) out.push({ role: "tool", tool_call_id: id, content: why });
    outstanding.clear();
    flushHeld();
  };

  for (const ev of events) {
    const b = ev.body;
    switch (b.type) {
      case "instructions.delivered":
        for (const seq of b.seqs) {
          const ins = bySeq.get(seq);
          if (!ins || ins.body.type !== "instruction") continue;
          const via =
            ins.body.fromSuggestion !== undefined
              ? `, adopting a suggestion from ${bySeq.get(ins.body.fromSuggestion)?.actor.name ?? "a teammate"}`
              : "";
          const interrupt = ins.body.interrupt ? " (interrupting your previous step)" : "";
          const atts = ins.body.attachments ?? [];
          const body = ins.body.text || (atts.length ? "(See the attached files.)" : "");
          const h = ins.body.handoff;
          const p = ins.body.peer;
          const head = h
            ? `[Handed off to you by ${h.fromName}${ins.actor.kind === "human" ? ` (sent by ${ins.actor.name})` : ""}${interrupt}]\nWhy: ${h.reason}${h.carried.length ? `\nAlready established:\n${h.carried.map((c) => `- ${c}`).join("\n")}` : ""}\n\nThe task:`
            : p
              ? `[${peerHead(p)} To answer, use message_session to "${p.fromTitle}".]\n\nThe message:`
              : ins.body.mesh
                ? meshHead(ins.body.mesh)
                : `[Instruction from ${ins.actor.name}, driver${via}${interrupt}]`;
          note([{ type: "text", text: `${head}\n${body}` }, ...attachmentParts(atts, opts)]);
        }
        break;

      case "agent.message": {
        if (outstanding.size) closeOutstanding("[No result recorded: the step was interrupted.]");
        const text = b.interrupted ? `${b.text}\n\n[interrupted before this turn finished]` : b.text;
        if (!b.text && b.toolCalls.length === 0) break;
        const msg: ChatMessage = { role: "assistant", content: text || null };
        if (b.toolCalls.length) {
          msg.tool_calls = b.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments || "{}" },
          }));
          if (b.reasoning?.length) msg.reasoning_details = b.reasoning;
          for (const c of b.toolCalls) outstanding.add(c.id);
        }
        out.push(msg);
        break;
      }

      case "tool.result":
        // The run loop's own reminders ("carry on", "reading is switched off")
        // are logged as results with no call behind them. Dropped here, the
        // model never saw one, so it was told nothing and did the same again.
        if (!outstanding.has(b.callId)) {
          if (/^(continue-|announced-|explore-nudge)/.test(b.callId) && b.output) note(`[session] ${b.output}`);
          break;
        }
        out.push({ role: "tool", tool_call_id: b.callId, content: clamp(b.output, b.name) });
        outstanding.delete(b.callId);
        if (outstanding.size === 0) flushHeld();
        break;

      case "control.granted":
        note(`[session] ${b.toName} is now the driver.`);
        break;
      case "session.updated":
        if (b.options.webSearch !== undefined) note(`[session] Web search is now ${b.options.webSearch ? "on" : "off"}.`);
        if (b.options.thinking !== undefined) note(`[session] Thinking mode is now ${b.options.thinking}.`);
        if (b.options.mcp !== undefined) note(`[session] Connected-service (MCP) tools are now ${b.options.mcp ? "available" : "off"}.`);
        if (b.options.agent !== undefined) note(`[session] The session now runs as ${b.options.agent ? `the "${b.options.agent.name}" agent` : "Friday's coding agent"}.`);
        break;
      // Stop: the task under way was ended, and the agent is free. It doesn't pick it back up unless the next message says so.
      case "run.pause":
        note(`[session] ${ev.actor.name} stopped the task you were on. Don't carry it on unless you're asked to: what comes next is what to do now.`);
        break;
      case "run.resume":
        note(`[session] ${ev.actor.name} paused you and has now resumed the run. Continue where you left off.`);
        break;
      case "run.cancel":
        note(`[session] ${ev.actor.name} cancelled the task in progress. Stop that work; wait for the next instruction.`);
        break;
      // Made the lead of the others, or no longer: said where it happened, so Friday Code knows from then on.
      case "lead.set":
        if (b.lane === (opts.lane ?? MAIN_LANE)) note(`[session] ${ev.actor.name} made you the lead of the agents in this session. For work bigger than one step, split it into self-contained pieces, give each to the agent best suited with assign_task (name the files each owns), keep what only you can do, follow with wait_for_agent, then check the pieces fit together and report.`);
        else note(`[session] ${ev.actor.name} ${b.lane ? "made another agent the lead" : "stopped any agent leading"}: ${b.lane ? "take work it assigns you as a request, and report back at the end" : "you take instructions from the people here as before"}.`);
        break;
      // Another agent's team update (post_update): the open line between the agents here, read where it falls.
      case "mesh.posted":
        if (b.fromLane !== (opts.lane ?? MAIN_LANE)) note(`[session] ${b.fromName}, another agent here, posted an update: ${b.text}`);
        break;
      case "folder.committed":
        note(`[session] ${ev.actor.name} committed ${b.files} file${b.files === 1 ? "" : "s"}${b.branch ? ` to ${b.branch}` : ""} (${b.sha.slice(0, 7)})${b.pushed ? ", pushed" : ""}${b.prUrl && b.prCreated ? `, and opened a pull request: ${b.prUrl}` : ""}.`);
        break;
      case "folder.restored":
        if (b.rewoundTo !== undefined) {
          note(`[session] ${ev.actor.name} rewound this session to before one of their earlier messages: the folder is back to how it was then (${b.restored} file${b.restored === 1 ? "" : "s"} restored, ${b.removed} removed), and everything said and done after that point has been set aside. Treat it as not having happened, carry on from what came before, and read files again before relying on them.`);
          break;
        }
        note(`[session] ${ev.actor.name} undid changes: the folder is back to how it was before an earlier run (${b.restored} file${b.restored === 1 ? "" : "s"} restored, ${b.removed} removed). Edits you made in that run are gone; read files again before relying on them.`);
        break;

      // Work that happened before this session existed, in someone's own
      // coding CLI. It is history, not an instruction: it says what has
      // already been tried and decided, so the same ground is not re-covered.
      case "session.imported":
        note(
          [
            b.fork ? `[session] ${ev.actor.name} forked this session from “${b.title}”.` : `[session] ${ev.actor.name} continued an earlier ${ENGINE_NAMES[b.tool] ?? b.tool} conversation here: “${b.title}”.`,
            ...(b.folder ? [`It was working in the ${b.folder} folder${b.branch ? `, on branch ${b.branch}` : ""}.`] : []),
            b.partial
              ? `Its last ${b.turns.length} messages follow; it was longer, and earlier ones are not available.`
              : b.total > b.turns.length
                ? `Its last ${b.turns.length} of ${b.total} messages follow; earlier ones are not available.`
                : "It went:",
            "",
            ...b.turns.map((t) => `${t.role === "user" ? "They said" : "The agent replied"}: ${t.text}`),
            "",
            "That is background, not a new instruction. Take it as work already done.",
          ].join("\n"),
        );
        break;
    }
  }

  if (outstanding.size) closeOutstanding("[No result recorded: the step was interrupted.]");
  flushHeld();

  // Last, so it survives trimming and is the freshest thing the model reads:
  // it is about the folder as it stands now, not about what happened earlier.
  if (opts.contended?.length) {
    out.push({
      role: "user",
      content: `[session] Another agent is working in this folder too, and has already changed:\n\n${opts.contended
        .map((l) => `- ${l}`)
        .join("\n")}\n\nRe-read a file before you rewrite it, and keep your change to what you were asked for.`,
    });
  }

  const trimmed = trim(out, opts.budget ?? DEFAULT_BUDGET);
  // Friday Code meets the shield's placeholder too (a typed key, a `cat .env`): told once what it is.
  if (JSON.stringify(trimmed).includes(HIDDEN)) trimmed.push({ role: "user", content: SHIELD_NOTE });

  /**
   * What has already been asked, and what came back.
   *
   * Put in front of everything rather than left in the transcript, because
   * the transcript is the thing that gets trimmed. A question and its answer
   * are a pair of ordinary turns, so a long session drops them like any
   * other — and an agent that cannot see it asked already does the only
   * thing it can, which is ask again. That is the loop: ask, get an answer,
   * work for twenty turns, lose the pair, ask the same question.
   *
   * Cheap to keep. One line each, and the whole point is that it stays when
   * everything around it goes.
   */
  const settled = answered(events);
  if (settled.length) {
    trimmed.unshift({
      role: "user",
      content: `[session] Decisions already made in this session. These are settled — do not ask about them again:\n\n${settled
        .map((q) => `- ${q.question} → ${q.answer}`)
        .join("\n")}`,
    });
  }

  // An entry saved empty was taken back (a cleared thumb), so it is gone.
  const memory = opts.memory?.filter((m) => m.text);
  if (memory?.length) {
    trimmed.unshift({
      role: "user",
      content: `[session] What you have saved so far. These stay true even after earlier turns drop out of your context:\n\n${memory
        .map((m) => `- ${m.key}: ${m.text}`)
        .join("\n")}`,
    });
  }
  return trimmed;
}

/**
 * What one tool may say back.
 *
 * A file read is capped on the machine, but at a size meant for source code —
 * and someone will read a CSV. Two of those filled the window on their own,
 * the oldest turns were dropped to make room, and the model, having lost every
 * file it had read, started again from the top. The tail is what matters least
 * in a long output, so it is the tail that goes.
 */
const MAX_RESULT = 20_000;
/**
 * A command's output is the other way round: the test summary, the last
 * compiler error and the exit come at the end, and there is no part of it to
 * read again. So it keeps a little of its start and most of its end.
 */
const COMMANDS = new Set(["run_command", "shell", "run_background", "read_background"]);
const COMMAND_HEAD = 3_000;

function clamp(output: string, name = ""): string {
  if (output.length <= MAX_RESULT) return output;
  if (COMMANDS.has(name)) {
    const cut = output.length - MAX_RESULT;
    return `${output.slice(0, COMMAND_HEAD)}\n\n[…${cut} characters left out of the middle of this command's output.]\n\n${output.slice(-(MAX_RESULT - COMMAND_HEAD))}`;
  }
  return `${output.slice(0, MAX_RESULT)}\n\n[…${output.length - MAX_RESULT} more characters. This output was too long to keep whole; read a specific part if you need more of it.]`;
}

/**
 * Drop whole turns from the oldest end until the context fits.
 *
 * Turns are dropped rather than truncated because an assistant turn and the
 * tool results answering it have to arrive together: a `tool` message whose
 * `tool_call_id` no longer matches anything is rejected by the API. So the cut
 * lands on a user message, which is always a safe boundary, and what was cut is
 * declared rather than silently vanishing.
 */
function trim(msgs: ChatMessage[], budget: number): ChatMessage[] {
  const size = (m: ChatMessage) => (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length) + 40;
  let total = msgs.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return openOnUser(msgs);

  // Keep the opening instruction: it is what the whole session is for.
  const keepFirst = msgs.length && msgs[0]!.role === "user" ? 1 : 0;
  let cut = keepFirst;
  let dropped = 0;
  while (cut < msgs.length - 1 && total > budget) {
    total -= size(msgs[cut]!);
    cut++;
    dropped++;
    // Land the cut on a user turn so no orphaned tool result survives it.
    while (cut < msgs.length - 1 && msgs[cut]!.role !== "user") {
      total -= size(msgs[cut]!);
      cut++;
      dropped++;
    }
  }
  // Counting them was not enough. A model that is told "12 turns are gone"
  // and nothing else does the only thing it can: it starts over, listing the
  // folder it has already listed. Naming the calls is what stops that — it can
  // see the work exists and ask for the one piece it actually needs.
  const did = calls(msgs.slice(keepFirst, cut));
  const note: ChatMessage = {
    role: "user",
    content:
      `[session] ${dropped} earlier turns were dropped from your context to stay inside the model's window. They happened; you just cannot see them any more.` +
      (did.length ? ` In them you already ran: ${did.join(", ")}. Don't run those again to find out what they said — carry on from here, and if you need one of them back, run just that one.` : "") +
      ` Everything you saved with remember is below.`,
  };
  return openOnUser([...msgs.slice(0, keepFirst), note, ...msgs.slice(cut)]);
}

/** The tool calls inside a stretch of turns, as short names a model can read. */
function calls(msgs: ChatMessage[]): string[] {
  const seen = new Set<string>();
  for (const m of msgs) {
    const made = m.role === "assistant" ? (m.tool_calls ?? []) : [];
    for (const c of made) {
      // The first argument is what identifies the call — the path, the query.
      let what = "";
      try {
        const args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
        const first = Object.values(args).find((v) => typeof v === "string");
        what = typeof first === "string" ? first.slice(0, 60) : "";
      } catch {
        // Unparseable arguments say nothing useful; the name alone will do.
      }
      seen.add(what ? `${c.function.name}(${what})` : c.function.name);
      if (seen.size >= 40) return [...seen];
    }
  }
  return [...seen];
}

/** The API needs the conversation to open with a user turn. */
function openOnUser(msgs: ChatMessage[]): ChatMessage[] {
  const out = [...msgs];
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

function attachmentParts(atts: Attachment[], opts: ContextOptions): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const a of atts) {
    const f = opts.files?.get(a.id);
    const label = `${a.name} (${a.type || "unknown type"}, ${formatBytes(a.size)})`;
    if (!f || f.kind === "missing") {
      parts.push({ type: "text", text: `[Attached file ${label} is no longer available.]` });
    } else if (f.kind === "text") {
      parts.push({ type: "text", text: `--- Attached file: ${label} ---\n${f.text}${f.truncated ? "\n[…truncated]" : ""}\n--- End of ${a.name} ---` });
    } else if (f.kind === "image") {
      if (opts.images) parts.push({ type: "text", text: `Attached image: ${label}` }, { type: "image_url", image_url: { url: f.dataUrl } });
      else parts.push({ type: "text", text: `[Image attached: ${label}. The current model can't view images, so ask the sender to describe it if it matters.]` });
    } else if (f.kind === "pdf") {
      parts.push({ type: "text", text: `Attached PDF: ${label}` }, { type: "file", file: { filename: a.name, file_data: f.dataUrl } });
    } else if (f.kind === "too_large") {
      parts.push({ type: "text", text: `[Attached file ${label} is too large to include.]` });
    } else {
      parts.push({ type: "text", text: `[Attached file ${label}: binary content not shown.]` });
    }
  }
  return parts;
}

/**
 * A model turn and its tool results belong to the lane that produced them:
 * replaying another lane's turns would make this agent "remember" work it never
 * did, and the tool_call ids would not match anything it asked for. Everything
 * else in the log is session-wide and stays — instructions, control changes,
 * settings. The shared document needs no special handling: it is state, read
 * with read_document, not history.
 */
const LANE_OWNED = new Set(["agent.message", "tool.result", "agent.diff"]);
/** What a lane was told. Delivered to one lane, it is that lane's: it is not a broadcast. */
const TOLD = new Set(["instruction", "instructions.delivered"]);

function forLane(events: SessionEvent[], lane: string, inherits: ReadonlySet<string>): SessionEvent[] {
  return events.filter((e) => {
    const owner = e.lane ?? MAIN_LANE;
    if (owner === lane) return true;
    if (LANE_OWNED.has(e.body.type)) return false;
    if (TOLD.has(e.body.type)) return inherits.has(owner);
    return true;
  });
}
