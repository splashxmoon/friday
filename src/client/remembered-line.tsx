import { useEffect, useState } from "react";
import type { BrainEntry } from "../brain.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import "./remembered-line.css";

/**
 * "Remembered: <text> · Undo" (Arun, 2026-11-20, wave 5: "when an agent's reply adds to memory, a quiet line"). One line in the chat for
 * each lesson a run or an agent's save_lesson put into the repo's project memory (brain.remembered). Undo takes it out again, or puts
 * the older wording back when it only brought one up to date. It looks at the brain to know whether the lesson is still as it was
 * said: once forgotten or reworded elsewhere (the Memory view, the memory page) there is nothing left here to undo.
 */
type Remembered = { repo: string; repoName: string; entry: string; kind: string; text: string; was?: { text: string; kind: string } };

// The client never imports brain.ts for a value (it pulls in node:crypto): types only.
const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

// One read per repo at a time: a long chat can hold many of these lines, and they all ask the same thing.
const cache = new Map<string, { at: number; read: Promise<BrainEntry[]> }>();
function entriesOf(identity: Identity, repo: string): Promise<BrainEntry[]> {
  const hit = cache.get(repo);
  if (hit && Date.now() - hit.at < 4000) return hit.read;
  const read = api<{ entries: BrainEntry[] }>(identity, `/api/brain/entries?repo=${encodeURIComponent(repo)}`).then((r) => r.entries, () => [] as BrainEntry[]);
  cache.set(repo, { at: Date.now(), read });
  return read;
}

export function RememberedLine({ identity, b, replaying }: { identity: Identity; b: Remembered; replaying?: boolean }) {
  // `kept`: still as said; `changed`: someone reworded it since, so it is theirs now; `gone`: forgotten.
  const [now, setNow] = useState<"checking" | "kept" | "changed" | "gone" | "undone">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void entriesOf(identity, b.repo).then((list) => {
      if (!live) return;
      const e = list.find((x) => x.id === b.entry);
      setNow((was) => (was === "undone" ? was : !e ? "gone" : e.text === b.text ? "kept" : "changed"));
    });
    return () => {
      live = false;
    };
  }, [identity, b.repo, b.entry, b.text]);
  const undo = async () => {
    setBusy(true);
    setError("");
    try {
      // Look again right before acting: if it was reworded or forgotten since this line was drawn, it is not this line's to undo.
      cache.delete(b.repo);
      const now = (await entriesOf(identity, b.repo)).find((x) => x.id === b.entry);
      if (!now || now.text !== b.text) {
        setNow(!now ? "gone" : "changed");
        return;
      }
      const q = `repo=${encodeURIComponent(b.repo)}&id=${encodeURIComponent(b.entry)}`;
      if (b.was) await api(identity, `/api/brain/entry?${q}`, { method: "PATCH", body: JSON.stringify({ text: b.was.text, kind: b.was.kind }) });
      else await api(identity, `/api/brain/entry?${q}`, { method: "DELETE" });
      cache.delete(b.repo);
      setNow("undone");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // A lesson forgotten elsewhere reads as forgotten here too, so a reload agrees with what was done.
  if (now === "gone" && !b.was) return <span className="rem-line rem-undone">Forgotten: {clipText(b.text, 140)}</span>;
  if (now === "undone") return <span className="rem-line rem-undone">{b.was ? "Put back as it was" : "Forgotten"}: {clipText(b.text, 140)}</span>;
  return (
    <span className="rem-line" title={`${b.text}\n\nKept in ${b.repoName}'s project memory, for every agent working there.`}>
      Remembered: {clipText(b.text, 140)}
      {now === "kept" && !replaying && (
        <>
          {" · "}
          <button type="button" className="rem-undo" disabled={busy} onClick={() => void undo()}>
            Undo
          </button>
        </>
      )}
      {error && <span className="rem-err"> · {error}</span>}
    </span>
  );
}
