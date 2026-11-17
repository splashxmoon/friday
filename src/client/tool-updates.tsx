import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsRow } from "@/components/dass";
import { Switch } from "@/components/ui/switch";
import type { ToolUpdate as Update } from "../runner/tool-updates.js";
import { ENGINE_NAMES, type EngineTool } from "../types.js";
import { hostApi } from "./local.js";
import type { Identity } from "./storage.js";

/**
 * The coding tools kept up to date (runner/tool-updates.ts; Arun, 2026-11-17: "make sure Friday is able to detect outdated CLI
 * things we are driving these agents from and auto update them"): which are behind, read once where the tools are listed, an
 * Update on the row of one that is, and the switch for updating by itself.
 */
type State = { auto: boolean; tools: Update[] };
let state: State | null = null;
let who: Identity | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const sub = (f: () => void) => (subs.add(f), () => void subs.delete(f));

async function look(): Promise<void> {
  if (!who) return;
  try {
    state = await hostApi<State>(who, "/api/runner/tools.updates");
    emit();
  } catch {
    // A computer from before this, or none connected: no updates said, nothing broken.
  }
}

/** Read which tools are behind, where the tools are listed (MachineBadge). */
export function useToolUpdates(identity: Identity): void {
  useEffect(() => {
    who = identity;
    void look();
  }, [identity.id]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** On a tool's row: Update when it is behind, Updating… while it is, and how it went. */
export function ToolUpdateButton({ tool }: { tool: EngineTool }) {
  const s = useSyncExternalStore(sub, () => state);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const u = s?.tools.find((t) => t.tool === tool);
  if (busy || u?.updating)
    return (
      <span className="mb-tool-upd" role="status">
        <span className="spinner tiny" aria-hidden />
        Updating
      </span>
    );
  if (said) return <span className={`mb-tool-upd ${said.ok ? "ok" : "bad"}`} title={said.ok ? undefined : said.text}>{said.ok ? said.text : "Couldn't update"}</span>;
  if (!u?.outdated || !u.how) return null;
  const update = async () => {
    if (!who) return;
    setBusy(true);
    try {
      const r = await hostApi<{ update: Update }>(who, "/api/runner/tools.update", { method: "POST", body: JSON.stringify({ tool }) });
      setSaid(r.update.last?.ok ? { ok: true, text: `Updated to ${r.update.version}` } : { ok: false, text: r.update.last?.error ?? "It didn't update." });
    } catch (e) {
      setSaid({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      void look();
    }
  };
  return (
    <button type="button" className="btn small mb-tool-go mb-tool-upd-btn" title={`${ENGINE_NAMES[tool]} ${u.version} → ${u.latest}, with ${u.how}`} onClick={() => void update()}>
      Update
    </button>
  );
}

/** Settings › Coding tools: updating them by itself, on unless turned off. */
export function AutoUpdateRow({ identity }: { identity: Identity }) {
  useToolUpdates(identity);
  const s = useSyncExternalStore(sub, () => state);
  if (!s) return null;
  const behind = s.tools.filter((t) => t.outdated && t.how).length;
  const set = async (on: boolean) => {
    if (!who) return;
    try {
      const r = await hostApi<{ auto: boolean }>(who, "/api/runner/tools.updates.auto", { method: "POST", body: JSON.stringify({ on }) });
      state = { ...s, auto: r.auto };
      emit();
    } catch {
      // Left as it was.
    }
  };
  return (
    <SettingsRow
      label="Keep coding tools up to date"
      hint={`Friday updates a coding tool when a newer version is out, the way it was installed, and never while it's working.${behind ? ` ${behind === 1 ? "One is" : `${behind} are`} behind now.` : ""}`}
    >
      <Switch aria-label="Keep coding tools up to date" checked={s.auto} onCheckedChange={(on) => void set(on)} />
    </SettingsRow>
  );
}
