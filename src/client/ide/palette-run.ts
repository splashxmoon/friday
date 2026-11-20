import { useEffect, useRef } from "react";
import { api } from "../api.js";
import { loadRecents, type Identity } from "../storage.js";
import { codeChatFor, isCodeChat, loadCodeChats, sameFolder, showCodeChat, useCodeChatFor, useCodeChats } from "./code-chats.js";
import { setIdeRoot, setMode, swapMode } from "./mode.js";
import type { VsCodeCommand } from "../WindowNav.js";

/**
 * Running Friday's palette in Code (Arun, 2026-11-19, wave 4: "one key for every Friday action from the IDE"). An action chosen in the
 * IDE's quick pick arrives as a key "action" (VsCodeView hands it to "friday:ide-action"), one chosen in the page's palette is
 * that same event: so each has one way of running, here, and it does what the button for it does (it clicks the button where the
 * button holds the logic: Self-review, Race, the tool picker).
 */
export interface RunCtx {
  identity: Identity;
  root: string | null;
  /** Show the chat column when it is hidden. */
  openChat: () => void;
}

const notice = (text: string): void => void window.dispatchEvent(new CustomEvent("friday:notice", { detail: text }));

/** Something the column draws a moment after it is asked for (a new chat's box is lazy): looked for until it is there. */
function whenFound<T extends HTMLElement>(selector: string, then: (el: T) => void, miss?: () => void, tries = 50): void {
  const look = (n: number) => {
    const el = document.querySelector<T>(selector);
    if (el) return then(el);
    if (n > 0) window.setTimeout(() => look(n - 1), 100);
    else miss?.();
  };
  look(tries);
}

import { ideIsUp, setIdeUp } from "./ide-up.js";
export { ideIsUp };

/** The frame holds the keyboard when the action came from inside the IDE: take it back, so typing carries on in the box. */
const focusBox = () =>
  whenFound<HTMLTextAreaElement>(".ia-new textarea", (el) => {
    window.focus();
    el.focus();
  });

const IDE_COMMAND: Record<string, VsCodeCommand> = { "ask-codebase": "askCodebase", review: "reviewChanges", "find-break": "findBreak", refactor: "refactorAcross" };

/**
 * What an action opens on this page (the race list, the tool picker, search) is typed into, or closed with Escape, so the keyboard
 * comes back from the IDE's frame first; the IDE's own commands keep it.
 */
const takeFocus = () => {
  window.focus();
  const at = document.activeElement as HTMLElement | null;
  if (at && at.tagName === "IFRAME") at.blur();
};

export function runIdeAction(id: string, c: RunCtx, arg: { sid?: string; invite?: string; words?: string } = {}): void {
  const root = c.root;
  if (!(id in IDE_COMMAND) && id !== "agents" && id !== "toggle-chat") takeFocus();
  const needFolder = () => (root ? true : (notice("Open a folder first"), false));
  const fresh = () => {
    showCodeChat(root!, "new");
    c.openChat();
  };
  switch (id) {
    case "new-chat":
      if (!needFolder()) return;
      fresh();
      // Words from the page's palette ("New chat: …") are put in the box; otherwise the box just takes the keyboard.
      if (arg.words)
        whenFound<HTMLTextAreaElement>(".ia-new textarea", (el) => {
          window.focus();
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, arg.words);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.focus();
        });
      else focusBox();
      return;
    case "race":
      if (!needFolder()) return;
      fresh();
      // The same ask goes to each tool, so the box needs its words first: said if it has none.
      whenFound<HTMLButtonElement>(
        ".ia-new .race-trig",
        (b) => {
          if (b.disabled || !document.querySelector<HTMLTextAreaElement>(".ia-new textarea")?.value.trim()) {
            focusBox();
            notice("Write the ask in the box, then race it");
          } else b.click();
        },
        () => notice("Racing needs two coding tools on this computer."),
      );
      return;
    case "switch-tool":
      if (!needFolder()) return;
      fresh();
      // A chat that has started keeps its tool; the new chat's box is where one is chosen.
      whenFound<HTMLButtonElement>(".ia-new .model-choice", (b) => b.click(), () => notice("There's no other coding tool to switch to."));
      return;
    case "self-review": {
      const chat = root ? codeChatFor(root) : null;
      if (!root || !chat) return notice("Open a chat first, then self-review it");
      // The column may be hidden, or showing an Ask or a Moved panel over the chat: bring the chat itself forward, then press its button.
      showCodeChat(root, chat.sid);
      c.openChat();
      whenFound<HTMLButtonElement>(
        'button[aria-label="Self-review"]',
        (b) => (b.disabled ? notice("Nothing to self-review yet: the chat has no changes.") : b.click()),
        () => notice("Open a chat first, then self-review it"),
        20,
      );
      return;
    }
    case "send-to-agents": {
      const chat = root ? codeChatFor(root) : null;
      if (!root || !chat) return notice("Open a chat first, then send it to Agents");
      // The column's own "Send to Agents" does it (its double-send guard, its Moved to Agents panel).
      showCodeChat(root, chat.sid);
      c.openChat();
      window.dispatchEvent(new CustomEvent("friday:send-away", { detail: chat.sid }));
      return;
    }
    case "hand-to-mate": {
      const chat = root ? codeChatFor(root) : null;
      if (!root || !chat) return notice("Open a chat first, then hand it to a teammate");
      // The column's own "More" lists the crew (hand-to-mate.tsx): bring the chat forward (it may be hidden, or under a Moved or Ask
      // panel), wait for the button, and open the menu unless it is open already (a click would close it).
      showCodeChat(root, chat.sid);
      c.openChat();
      whenFound<HTMLButtonElement>(
        ".ia-hand button",
        (b) => b.getAttribute("aria-expanded") !== "true" && b.click(),
        () => notice("Open a chat first, then hand it to a teammate"),
        20,
      );
      return;
    }
    case "search":
      window.focus();
      window.dispatchEvent(new Event("friday:search"));
      return;
    case "settings":
      setMode("agents");
      window.dispatchEvent(new CustomEvent("friday:settings", { detail: {} }));
      return;
    case "open-session":
      {
        // The invite comes from this page's own list of sessions, never from what came back through the IDE.
        const mine = arg.sid ? loadRecents().find((r) => r.sid === arg.sid && !isCodeChat(r.sid)) : undefined;
        if (mine) window.dispatchEvent(new CustomEvent("friday:code-to-agents", { detail: { sid: mine.sid, invite: mine.invite, title: "", open: true } }));
      }
      return;
    case "open-folder":
      window.dispatchEvent(new Event("friday:ide-open-folder"));
      return;
    case "agents":
      swapMode();
      return;
    case "toggle-chat":
      window.dispatchEvent(new Event("friday:vsc-agent"));
      return;
    // The IDE's own commands, from the page's palette (the runner and the extension each check the name).
    case "ask-codebase":
    case "review":
    case "find-break":
    case "refactor":
      window.dispatchEvent(new CustomEvent("friday:vsc-command", { detail: IDE_COMMAND[id] }));
      return;
    default: {
      // One of Code's chats, picked by its id.
      const chat = id.startsWith("chat:") ? loadCodeChats().find((x) => x.sid === id.slice(5)) : undefined;
      if (!chat) return;
      if (!root || !sameFolder(chat.folder, root)) setIdeRoot(chat.folder);
      showCodeChat(chat.folder, chat.sid);
      c.openChat();
    }
  }
}

/**
 * What the IDE's palette and the page's palette need of this page: the "friday:ide-action" events that run an action, ⇧⌘' on the
 * page itself (inside the IDE's frame the IDE's own key rules, and opens its quick pick), and a feed of what only this page knows
 * (the Agents sessions to open, the chat the column shows) for the IDE to read when its palette opens (/api/vscode/palette).
 */
export function useIdeActions(c: RunCtx & { active: boolean }): void {
  const now = useRef(c);
  now.current = c;
  const { active, identity, root } = c;
  const chats = useCodeChats();
  const shown = useCodeChatFor(root ?? "");
  useEffect(() => {
    if (!active) return;
    setIdeUp(true);
    const run = (e: Event) => {
      const d = (e as CustomEvent<{ id?: string; sid?: string; invite?: string; words?: string }>).detail;
      if (d?.id) runIdeAction(d.id, now.current, d);
    };
    // One key on the page too, so it is the same wherever focus is: it opens the page's palette, which lists the same actions.
    const key = (e: KeyboardEvent) => {
      if (e.code === "Quote" && e.shiftKey && !e.altKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("friday:palette"));
      }
    };
    window.addEventListener("friday:ide-action", run);
    window.addEventListener("keydown", key, true);
    return () => {
      setIdeUp(false);
      window.removeEventListener("friday:ide-action", run);
      window.removeEventListener("keydown", key, true);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    let last = "";
    const send = () => {
      if (document.hidden) return;
      const agents = loadRecents()
        .filter((r) => !isCodeChat(r.sid))
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, 20)
        .map((r) => ({ sid: r.sid, invite: r.invite, title: r.alias || r.title, at: r.openedAt }));
      const chat = shown && root && sameFolder(shown.folder, root) ? { sid: shown.sid, folder: shown.folder, title: shown.title } : null;
      const body = JSON.stringify({ agents, chat });
      if (body === last) return;
      last = body;
      void api(identity, "/api/vscode/palette", { method: "POST", body }).catch(() => (last = ""));
    };
    send();
    // Agents' list changes in App's own state, which says nothing to here: a slow look, and one whenever the window is shown again.
    const timer = window.setInterval(send, 10_000);
    document.addEventListener("visibilitychange", send);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", send);
    };
  }, [active, identity, root, shown, chats]);
}
