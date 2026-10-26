import { useEffect, useState } from "react";
import type { AgentRecord } from "../agent-record.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";

/** Each agent's record, by id, with a way into the session it last ran in. */
export type AgentRecordView = AgentRecord & { last?: { sid: string; at: number; invite: string } };

/** Every agent's track record, read once and again whenever `key` changes (the number of agents, a save). */
export function useAgentRecords(identity: Identity, key: unknown = 0): Record<string, AgentRecordView> {
  const [records, setRecords] = useState<Record<string, AgentRecordView>>({});
  useEffect(() => {
    let live = true;
    api<{ records: Record<string, AgentRecordView> }>(identity, "/api/agents/stats")
      .then((r) => live && setRecords(r.records))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [identity.id, key]);
  return records;
}

/** "3 runs · 2 done · tests 2/2": the record in one short line, or "" when there is nothing to say. */
export function recordLine(r: AgentRecordView | undefined): string {
  if (!r || !r.runs) return "";
  const tested = r.testsPassed + r.testsFailed;
  return [`${r.runs} run${r.runs === 1 ? "" : "s"}`, `${r.done} done`, r.failed ? `${r.failed} failed` : "", tested ? `tests ${r.testsPassed}/${tested}` : ""].filter(Boolean).join(" · ");
}
