import { useEffect, useState } from "react";
import { NO_FOLDERS, type CrewFolders } from "../crew-folders.js";
import { api } from "./api.js";
import type { Identity } from "./storage.js";
import type { Confirmation, MenuItem } from "./ui.js";

/**
 * The crew's project groups in the page (called groups on screen: Arun, 2026-11-15, "dont say new folder, say new group") (crew-folders.ts; Arun, 2026-11-15: "placing agents and like crew rooms into prodject
 * folders too... like categories"; "you can also rename the categories too"). Read once, kept here, and every change written
 * whole; the sidebar's lists draw from it. Which folders are folded is this window's own (localStorage).
 */
let kept: CrewFolders = NO_FOLDERS;
let loaded = false;
const listeners = new Set<(f: CrewFolders) => void>();
const say = (f: CrewFolders) => ((kept = f), listeners.forEach((l) => l(f)));

export function useCrewFolders(identity: Identity): [CrewFolders, (next: CrewFolders) => Promise<void>] {
  const [f, setF] = useState(kept);
  useEffect(() => {
    listeners.add(setF);
    if (!loaded) {
      loaded = true;
      void api<CrewFolders>(identity, "/api/teammates/folders").then(say, () => (loaded = false));
    }
    return () => void listeners.delete(setF);
  }, [identity]);
  const save = async (next: CrewFolders) => {
    const was = kept;
    say(next);
    try {
      say(await api<CrewFolders>(identity, "/api/teammates/folders", { method: "PUT", body: JSON.stringify(next), headers: { "Content-Type": "application/json" } }));
    } catch (e) {
      say(was);
      throw e;
    }
  };
  return [f, save];
}

const SHUT = "friday.crewFolders.shut";
export function useShutFolders(): [Set<string>, (id: string) => void] {
  const [shut, setShut] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(SHUT) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const flip = (id: string) =>
    setShut((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      try {
        localStorage.setItem(SHUT, JSON.stringify([...n]));
      } catch {
        /* this window only */
      }
      return n;
    });
  return [shut, flip];
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** A new folder, named in the app's own dialog; `then` places something in it once it is made. */
export function askNewFolder(ask: (c: Confirmation) => void, f: CrewFolders, save: (n: CrewFolders) => Promise<void>, then?: string): void {
  ask({
    title: "New group",
    body: "A group for a project: put crew mates and rooms in it from their right-click, or drag them onto it.",
    action: "Make group",
    danger: false,
    icon: "list",
    input: { label: "Group name", value: "", maxLength: 40 },
    onConfirm: (name) => {
      const n = name.replace(/\s+/g, " ").trim();
      if (!n) return Promise.reject(new Error("Give it a name."));
      const id = newId();
      return save({ folders: [...f.folders, { id, name: n }], place: then ? { ...f.place, [then]: id } : f.place });
    },
  });
}

/** Moving a crew mate or a room: each folder, out of its folder, or into a new one. */
export function moveItems(key: string, f: CrewFolders, save: (n: CrewFolders) => Promise<void>, ask: (c: Confirmation) => void): MenuItem[] {
  const now = f.place[key];
  const to = (id: string | null) => {
    const place = { ...f.place };
    if (id) place[key] = id;
    else delete place[key];
    void save({ ...f, place });
  };
  return [
    { heading: "Move to group" },
    ...f.folders.map((x): MenuItem => ({ label: x.name, icon: "list", checked: now === x.id, onSelect: () => to(x.id) })),
    now ? { label: "Out of its group", icon: "x", onSelect: () => to(null) } : null,
    { label: "New group…", icon: "plus", onSelect: () => askNewFolder(ask, f, save, key) },
  ];
}

/** A folder's own menu: rename it, or remove it, which lets out what is in it and removes nothing else. */
export function folderItems(id: string, f: CrewFolders, save: (n: CrewFolders) => Promise<void>, ask: (c: Confirmation) => void): MenuItem[] {
  const folder = f.folders.find((x) => x.id === id);
  if (!folder) return [];
  const inIt = Object.values(f.place).filter((v) => v === id).length;
  return [
    {
      label: "Rename…",
      icon: "pencil",
      onSelect: () =>
        ask({
          title: "Rename group",
          action: "Rename",
          danger: false,
          icon: "pencil",
          input: { label: "Group name", value: folder.name, maxLength: 40 },
          onConfirm: (name) => {
            const n = name.replace(/\s+/g, " ").trim();
            if (!n) return Promise.reject(new Error("Give it a name."));
            return save({ ...f, folders: f.folders.map((x) => (x.id === id ? { ...x, name: n } : x)) });
          },
        }),
    },
    {
      label: "Remove group…",
      icon: "trash",
      danger: true,
      onSelect: () =>
        ask({
          title: `Remove ${folder.name}?`,
          body: inIt ? `The group goes. ${inIt === 1 ? "What's in it stays" : `The ${inIt} in it stay`} in your crew, under Not in a group.` : "It's empty. Nothing else changes.",
          action: "Remove group",
          onConfirm: () => save({ folders: f.folders.filter((x) => x.id !== id), place: Object.fromEntries(Object.entries(f.place).filter(([, v]) => v !== id)) }),
        }),
    },
  ];
}

/** Dragging a crew mate or a room onto a folder: what is being dragged, by its key. */
export const DRAG_TYPE = "application/x-friday-crew";
