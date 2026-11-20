import { api } from "../api.js";
import { hostApi } from "../local.js";
import type { Identity } from "../storage.js";
import { ENGINE_NAMES, type EngineEffort, type EngineMode, type EngineTool } from "../../types.js";
import { RACE_PREFIX } from "../race-prefix.js";
import { raceTitle } from "./race.js";

const LETTERS = ["A", "B", "C"];

/**
 * What the box says besides the words, as it stands when Race is pressed (Arun, 2026-11-19, wave 2: "Race the tools"): the
 * permissions, and the tool, model, account and effort picked in it for the tool the box is on. A taken ticket or pull request is
 * already in `ask` (Code.tsx withIssue/withPr); `session` carries its link for the chat.
 */
export interface RaceBox {
  mode: EngineMode;
  fullAccess?: boolean;
  /** The tool the box is on: the model, account and effort picked apply to it, and to no other. */
  engine: EngineTool | "";
  model?: string;
  account?: string;
  effort?: EngineEffort | null;
  /** The ticket or pull request taken in the box, as the session records it. */
  session?: Record<string, unknown>;
  /** The words as typed, for the tab's name (`ask` may carry a ticket's text after them). */
  typed?: string;
}

/**
 * Start a race from Code's box: a chat of Code's own (its first tool in the folder, left idle, is where the conversation carries on
 * after the race, at the permissions picked) with a racer per tool, each in a checkout of its own (the same runner call Race.tsx's
 * dialog makes), and the same ask sent to each. Half a race is not a race: whatever started is taken back when one fails, copies
 * and all, and the chat with it.
 */
export async function startRace(identity: Identity, folder: string, tools: EngineTool[], ask: string, box: RaceBox, note: (s: string) => void = () => {}): Promise<{ sid: string; invite: string }> {
  const first = tools[0]!;
  const made = await api<{ sessionId: string; invites: Record<string, string> }>(identity, "/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      userId: identity.id,
      name: identity.name,
      title: raceTitle(box.typed ?? ask),
      kind: "code",
      goal: "",
      engine: first,
      ...(box.session ?? {}),
      ...(box.effort && box.engine === first ? { effort: box.effort } : {}),
    }),
  });
  const sid = made.sessionId;
  const invite = made.invites.owner!;
  // What was cut for each racer, to be put away if the race does not start: stopping a runner leaves its copy where it is.
  const started: { lane: string; cwd?: string }[] = [];
  // The box's own picks, for the tool they were made for.
  const picks = (tool: EngineTool) => (tool === box.engine ? { ...(box.model ? { model: box.model } : {}), ...(box.account ? { account: box.account } : {}) } : {});
  try {
    note(`Opening ${ENGINE_NAMES[first]} in the folder…`);
    await hostApi(identity, "/api/runner/start", {
      method: "POST",
      body: JSON.stringify({ sid, invite, tool: first, cwd: folder, mode: box.mode, handMode: box.mode, ...(box.fullAccess && box.mode === "full" ? { fullAccess: true } : {}), ...picks(first) }),
    });
    for (const [i, tool] of tools.entries()) {
      note(`Making a copy for ${ENGINE_NAMES[tool]}…`);
      const res = await hostApi<{ lane: string; cwd?: string }>(identity, "/api/runner/start", {
        method: "POST",
        // Free to run the tests: that is half of what there is to compare, and it is a copy.
        body: JSON.stringify({ sid, invite, tool, cwd: folder, mode: "full", worktree: true, newLane: `${RACE_PREFIX}${LETTERS[i]} · ${ENGINE_NAMES[tool]}`, ...picks(tool) }),
      });
      started.push({ lane: res.lane, cwd: res.cwd });
    }
    note("Sending the ask…");
    for (const { lane } of started) {
      await api(identity, `/api/sessions/${encodeURIComponent(sid)}/instruct?invite=${encodeURIComponent(invite)}`, { method: "POST", body: JSON.stringify({ text: ask.trim(), lane }) });
    }
    return { sid, invite };
  } catch (e) {
    for (const { lane, cwd } of started) {
      await hostApi(identity, "/api/runner/stop", { method: "POST", body: JSON.stringify({ sid, lane }) }).catch(() => {});
      if (cwd) await hostApi(identity, "/api/runner/worktree.drop", { method: "POST", body: JSON.stringify({ path: cwd }) }).catch(() => {});
    }
    await hostApi(identity, "/api/runner/stop", { method: "POST", body: JSON.stringify({ sid, lane: "main" }) }).catch(() => {});
    void api(identity, "/api/sessions/mine/forget", { method: "POST", body: JSON.stringify({ sid }) }).catch(() => {});
    throw e;
  }
}
