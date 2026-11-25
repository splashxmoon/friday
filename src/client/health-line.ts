import type { Health } from "../diagnostics.js";
import { bytes } from "./SettingsStorage.js";
import { agoWords } from "./ui.js";

/**
 * Settings › Updates › Health in words (spec 13 Wave 4; Arun, 2026-11-24: "Go all out and fix these problems"): one row for each of
 * what the server reads (diagnostics.ts health), what it says now, and when it's off, how bad and the plain fix, a place to go or a
 * thing to press. Here rather than in the page, so a test reads every case without drawing it.
 */
export interface HealthRow {
  id: "save" | "disk" | "data" | "log" | "errors";
  label: string;
  /** What it says now. Empty while it is being measured (the page draws a placeholder). */
  text: string;
  /** Off: how bad (red when work could be lost, amber when it wants a look), and the badge's word. */
  off?: { tone: "danger" | "needs"; word: string };
  /** What to do about it: Settings › Storage, or a report with diagnostics. */
  fix?: { label: string; to: "storage" | "feedback" };
}

/** Under this much free, the disk is nearly full: Friday's saves, copies of repos and coding tools all need room. */
export const DISK_LOW = 5 * 1024 ** 3;
/** Over this, Friday's folder is worth a look in Storage (copies of repos left behind are most of a big one). */
export const DATA_BIG = 20 * 1024 ** 3;

const storage = (label = "Open Storage") => ({ label, to: "storage" as const });
/** As Storage says a size, without a trailing ".0" ("15 MB", not "15.0 MB"). */
const size = (n: number) => bytes(n).replace(/\.0 /, " ");

export function healthRows(h: Health): HealthRow[] {
  const rows: HealthRow[] = [];

  const f = h.save.failing;
  if (f) {
    const full = /disk is full|quota|space/i.test(f.reason);
    rows.push({
      id: "save",
      label: "Saving",
      text: `Can't save: ${f.reason}. Friday keeps trying, and holds your changes until it can.`,
      off: { tone: "danger", word: "Not saving" },
      fix: full ? storage("Free up space") : { label: "Send feedback", to: "feedback" },
    });
  } else
    rows.push({
      id: "save",
      label: "Saving",
      text: h.save.savedAt === null ? (h.save.pending ? "Saving your first changes." : "Nothing to save yet.") : h.save.pending ? `Last saved ${agoWords(h.save.savedAt)}. The newest change is saved in a moment.` : `Everything is saved. Last saved ${agoWords(h.save.savedAt)}.`,
    });

  if (!h.disk) rows.push({ id: "disk", label: "Disk space", text: "Couldn't be read on this computer." });
  else if (h.disk.free < DISK_LOW)
    rows.push({ id: "disk", label: "Disk space", text: `Disk nearly full: ${size(h.disk.free)} free of ${size(h.disk.total)}. Storage frees space.`, off: { tone: "needs", word: "Nearly full" }, fix: storage() });
  else rows.push({ id: "disk", label: "Disk space", text: `${size(h.disk.free)} free of ${size(h.disk.total)}.` });

  const d = h.data;
  if (d.bytes === null) rows.push({ id: "data", label: "Data folder", text: d.measuring ? "" : "Not measured yet. Storage measures it.", ...(d.measuring ? {} : { fix: storage() }) });
  else if (d.bytes > DATA_BIG) rows.push({ id: "data", label: "Data folder", text: `${size(d.bytes)} in Friday's folder. Storage frees space.`, off: { tone: "needs", word: "Large" }, fix: storage() });
  else rows.push({ id: "data", label: "Data folder", text: `${size(d.bytes)}${d.at ? `, measured ${agoWords(d.at)}` : ""}.` });

  rows.push({ id: "log", label: "Log size", text: h.log.bytes ? `${size(h.log.bytes)}, kept under ${size(h.log.most)}.` : "Nothing logged yet." });

  const n = h.errors.week;
  rows.push(
    n
      ? { id: "errors", label: "Errors", text: `${n} this week, the last ${agoWords(h.errors.last ?? h.at)}. Copy diagnostics below and send it with a report.`, off: { tone: "needs", word: n === 1 ? "1 error" : `${n} errors` }, fix: { label: "Send feedback", to: "feedback" } }
      : { id: "errors", label: "Errors", text: "None this week." },
  );
  return rows;
}
