import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Friday's look over VS Code's own chrome, where its settings and themes can't reach (Arun, 2026-11-19: "making these bigger and
 * using the same like button click highlight and hover too", "get rid of this too" of the gear, "the friday logo" in the empty
 * editor). One stylesheet, linked from code-server's workbench page when the build is slimmed (slimBuild), so the copy in the app
 * and a downloaded one look the same. Colours follow VS Code's theme class (Friday Dark is vs-dark, Friday Light is vs), in the
 * values of Friday's own --hover and --hover-strong.
 */

/** Friday's mark (src/client/icons.tsx FridayMark), as a mask: the empty editor's logo takes the theme's colour. */
const MARK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 5 92 92"><path d="M44.40 7.23L11.46 26.25A2.6 2.6 0 0 0 10.16 28.50L10.16 66.53A2.6 2.6 0 0 0 14.06 68.79L33.98 57.29A2.6 2.6 0 0 0 35.28 55.04L35.28 43.00A2.6 2.6 0 0 1 36.58 40.75L47.00 34.73A2.6 2.6 0 0 0 48.30 32.48L48.30 9.48A2.6 2.6 0 0 0 44.40 7.23Z"/><path d="M51.70 9.48L51.70 32.48A2.6 2.6 0 0 0 53.00 34.73L63.42 40.75A2.6 2.6 0 0 1 64.72 43.00L64.72 55.04A2.6 2.6 0 0 0 66.02 57.29L85.94 68.79A2.6 2.6 0 0 0 89.84 66.53L89.84 28.50A2.6 2.6 0 0 0 88.54 26.25L55.60 7.23A2.6 2.6 0 0 0 51.70 9.48Z"/><path d="M15.76 76.23L48.70 95.25A2.6 2.6 0 0 0 51.30 95.25L84.24 76.23A2.6 2.6 0 0 0 84.24 71.73L64.32 60.23A2.6 2.6 0 0 0 61.72 60.23L51.30 66.25A2.6 2.6 0 0 1 48.70 66.25L38.28 60.23A2.6 2.6 0 0 0 35.68 60.23L15.76 71.73A2.6 2.6 0 0 0 15.76 76.23Z"/></svg>`,
  );

/** A magnifier for the search box (the stroke of Friday's own search icon), as a mask. */
const LOOKING_GLASS =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`);

export const FRIDAY_SKIN_CSS = `/* Friday's skin for VS Code (src/runner/vscode-skin.ts). */
.monaco-workbench { --fr-hover: rgb(255 255 255 / .06); --fr-press: rgb(255 255 255 / .1); --fr-mark: rgb(255 255 255 / .09); --fr-key: rgb(255 255 255 / .07);
  --fr-card: #1f1f1f; --fr-border: rgb(255 255 255 / .08); --fr-border-strong: rgb(255 255 255 / .12); --fr-ink: #ededed; --fr-ink-2: #b5b5b5; --fr-muted: #929292;
  --fr-find: color-mix(in srgb, #f2b453 34%, transparent); --fr-shadow: 0 0 0 1px rgb(255 255 255 / .04), 0 12px 32px rgb(0 0 0 / .45);
  --fr-badge: #d4d4d4; --fr-badge-ink: #141414; --fr-conflict-cur: #8fdcb2; --fr-conflict-inc: #a9c3fa; --fr-conflict-bg: color-mix(in srgb, #f2b453 13%, transparent); --fr-conflict-line: color-mix(in srgb, #f2b453 38%, transparent); --fr-conflict-ink: #f2b453; }
.monaco-workbench.vs { --fr-hover: rgb(0 0 0 / .05); --fr-press: rgb(0 0 0 / .085); --fr-mark: rgb(0 0 0 / .1); --fr-key: rgb(0 0 0 / .06);
  --fr-card: #ffffff; --fr-border: rgb(0 0 0 / .08); --fr-border-strong: rgb(0 0 0 / .14); --fr-ink: #1a1a1a; --fr-ink-2: #4a4a4a; --fr-muted: #67676c;
  --fr-find: color-mix(in srgb, #f2b453 45%, transparent); --fr-shadow: 0 12px 32px rgb(0 0 0 / .12);
  --fr-badge: #3a3a3a; --fr-badge-ink: #ffffff; --fr-conflict-cur: #1d7a4b; --fr-conflict-inc: #2f5fc4; --fr-conflict-bg: color-mix(in srgb, #f2b453 18%, transparent); --fr-conflict-line: color-mix(in srgb, #c98a16 40%, transparent); --fr-conflict-ink: #9a5507; }

/* The right side bar is the room Friday's chat lies over (VsCodeView.tsx): its own title and views stay unseen beneath it, so
   nothing flashes there while the chat draws. Its edge (the sash) is the IDE's, and resizes the chat. */
.monaco-workbench .part.auxiliarybar > * { visibility: hidden; }
/* The IDE's notices and their list, beside the chat rather than under it (FRIDAY_SKIN_JS sets --fr-aux-w to the bar's width). */
.monaco-workbench > .notifications-toasts, .monaco-workbench > .notifications-center { margin-right: var(--fr-aux-w, 0px); }

/* Go to File, the command palette and every other pick list: Friday's search window (SearchModal.tsx .quick.srch). A card with a
   hairline border and a soft shadow, the query on a roomy line of its own with a magnifier, a rule under it, rounded rows with
   Friday's selected fill, matches marked in amber. Row heights stay VS Code's: its list places rows by them. */
/* Under Friday's search pill wherever it sits (FRIDAY_SKIN_JS sets --fr-qi-x from where Friday says the pill is). */
.monaco-workbench .quick-input-widget { translate: var(--fr-qi-x, 0px) 0; }
.monaco-workbench .quick-input-widget { --vscode-list-highlightForeground: var(--fr-ink); --vscode-list-focusHighlightForeground: var(--fr-ink); --vscode-quickInputList-focusForeground: var(--fr-ink); margin-top: 6px; padding: 0 !important; border: 1px solid var(--fr-border-strong) !important; border-radius: 12px !important; background-color: var(--fr-card) !important; box-shadow: var(--fr-shadow) !important; overflow: hidden; }
.monaco-workbench .quick-input-widget .quick-input-titlebar { background: transparent !important; }
.monaco-workbench .quick-input-widget .quick-input-header { position: relative; margin: 0 !important; padding: 9px 12px 9px 38px !important; border-bottom: 1px solid var(--fr-border); }
.monaco-workbench .quick-input-widget .quick-input-header::before { content: ""; position: absolute; left: 14px; top: 50%; width: 15px; height: 15px; margin-top: -7.5px; background-color: var(--fr-muted); -webkit-mask: url("${LOOKING_GLASS}") center / contain no-repeat; mask: url("${LOOKING_GLASS}") center / contain no-repeat; }
.monaco-workbench .quick-input-widget .monaco-inputbox { border: 0 !important; background: transparent !important; outline: 0 !important; box-shadow: none !important; }
.monaco-workbench .quick-input-widget .monaco-inputbox.synthetic-focus, .monaco-workbench .quick-input-widget .monaco-inputbox:focus-within { outline: 0 !important; }
.monaco-workbench .quick-input-widget .monaco-inputbox > .ibwrapper > .input { padding: 4px 0 !important; color: var(--fr-ink) !important; font-size: 14px !important; letter-spacing: -.005em; }
.monaco-workbench .quick-input-widget .monaco-inputbox > .ibwrapper > .input::placeholder { color: var(--fr-muted) !important; }
.monaco-workbench .quick-input-widget .quick-input-progress { position: absolute; left: 0; right: 0; }
.monaco-workbench .quick-input-widget .quick-input-list { margin: 0 !important; padding: 6px 0; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-list-rows { background: transparent !important; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-list-row { left: 6px !important; right: 6px; width: calc(100% - 12px) !important; border-radius: 7px; color: var(--fr-ink-2); }
/* Each row's contents centred in its (taller) height, with room at the sides; a detail line sits a little apart from its title. */
.monaco-workbench .quick-input-widget .quick-input-list .monaco-tl-row, .monaco-workbench .quick-input-widget .quick-input-list .monaco-tl-contents { height: 100%; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-tl-twistie { padding-left: 4px !important; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-entry { box-sizing: border-box; height: 100%; align-items: center; padding: 0 8px 0 4px !important; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-label { align-items: center; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-rows { display: flex; flex-direction: column; justify-content: center; gap: 3px; line-height: 18px; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-rows > .quick-input-list-row { line-height: 18px; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-label-meta { font-size: 12px; color: var(--fr-muted); opacity: 1 !important; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-separator { margin-left: 12px; font-size: 11.5px; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-separator-as-item { padding: 10px 6px 2px !important; font-size: 12px; font-weight: 500; color: var(--fr-muted); }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-entry .codicon:not(.action-label) { margin-right: 4px; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-list-row:hover:not(.focused) { background-color: var(--fr-hover) !important; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-list-row.focused { background-color: var(--fr-press) !important; color: var(--fr-ink) !important; outline: 0 !important; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-list-row.focused .label-name, .monaco-workbench .quick-input-widget .quick-input-list .monaco-list-row.focused .codicon { color: var(--fr-ink) !important; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-list .monaco-list-row .highlight, .monaco-workbench .quick-input-widget .quick-input-list .monaco-list:focus .monaco-list-row.focused .monaco-highlighted-label .highlight,
.monaco-workbench .quick-input-widget .quick-input-list .highlight { padding: 0 1px; border-radius: 3px; background-color: var(--fr-find) !important; color: var(--fr-ink) !important; font-weight: inherit !important; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-separator, .monaco-workbench .quick-input-widget .quick-input-list .label-description { color: var(--fr-muted) !important; }
.monaco-workbench .quick-input-widget .quick-input-list .quick-input-list-entry.quick-input-list-separator-border { border-top-color: var(--fr-border) !important; }
.monaco-workbench .quick-input-widget .quick-input-list .monaco-keybinding-key { border: 0 !important; box-shadow: none !important; background-color: var(--fr-key) !important; border-radius: 5px; color: var(--fr-ink-2) !important; }
.monaco-workbench .quick-input-widget .quick-input-message { color: var(--fr-muted); }

/* The activity bar: each view a 36px rounded square in the 48px bar, a 20px icon, Friday's hover and pressed fill, and no
   coloured line beside the open one (the rail's own buttons, Sidebar.tsx .oss-rail-btn). */
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item { width: 36px; height: 36px; margin: 4px auto 0; border-radius: 9px; transition: background-color 120ms ease; }
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item:hover { background-color: var(--fr-hover); }
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item.checked,
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item.clicked:focus,
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item:active { background-color: var(--fr-press); }
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item .action-label { width: 36px !important; height: 36px !important; padding: 0 !important; font-size: 20px !important; line-height: 36px; display: flex; align-items: center; justify-content: center; -webkit-mask-size: 20px !important; mask-size: 20px !important; }
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item .action-label.codicon::before { font-size: 20px; }
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item .active-item-indicator { display: none !important; }
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item:focus::before,
.monaco-workbench .activitybar > .content .monaco-action-bar .action-item:focus-visible { outline-offset: -2px; border-radius: 9px; }
/* A count on a view (Source Control's changes): a small quiet pill on the square's corner, cut out of the bar, not a blue disc
   over the icon (Arun, 2026-11-19: "fix this"). */
/* At the square's bottom right, under the icon's corner, not over its top (Arun, 2026-11-19: "move that notification to the bottom right"). */
.monaco-workbench .activitybar > .content .monaco-action-bar .badge { position: absolute; top: auto !important; left: auto !important; right: 0 !important; bottom: 1px !important; width: auto !important; height: auto !important; }
.monaco-workbench .activitybar > .content .monaco-action-bar .badge .badge-content { position: static !important; box-sizing: border-box; min-width: 14px; height: 14px; padding: 0 3.5px !important; border-radius: 7px; background-color: var(--fr-badge) !important; color: var(--fr-badge-ink) !important; font-size: 9px !important; font-weight: 600; line-height: 14px !important; text-align: center; box-shadow: 0 0 0 2px var(--vscode-activityBar-background); }
/* No remote-window button at the status bar's start: Friday runs VS Code on this computer, and its list is empty here. */
.monaco-workbench .statusbar-item#status\\.host { display: none !important; }
/* The gear at the foot stays, VS Code's settings, keyboard shortcuts, themes and extensions behind it (Arun, 2026-11-19: "we need a
   way to see the ide settings... add back the setting button in the rail at the bottom"); accounts don't, Friday signs nothing in. */
.monaco-workbench .activitybar .action-item:has(.codicon-accounts-view-bar-icon) { display: none !important; }
.monaco-workbench .activitybar > .content > :not(.composite-bar) .action-item { margin-bottom: 6px; }

/* The empty editor: Friday's mark in place of VS Code's, and its shortcuts as rows that look as clickable as they are. */
.monaco-workbench .editor-group-watermark .watermark-container .letterpress {
  width: 72px !important; height: 72px !important; max-width: none !important; aspect-ratio: 1 / 1; margin: 0 auto 26px;
  background-image: none !important; background-color: var(--fr-mark);
  -webkit-mask: url("${MARK}") center / contain no-repeat; mask: url("${MARK}") center / contain no-repeat;
}
.monaco-workbench .editor-group-watermark .watermark-box { margin-top: 0; }
.monaco-workbench .editor-group-watermark .watermark-box .actions-container { gap: 2px; }
.monaco-workbench .editor-group-watermark .watermark-box .action-item { margin: 0 0 2px !important; }
.monaco-workbench .editor-group-watermark .watermark-entry { display: flex !important; align-items: center; gap: 10px; box-sizing: border-box; min-width: 260px; height: 32px !important; padding: 0 10px !important; border-radius: 8px; cursor: pointer; transition: background-color 120ms ease; }
.monaco-workbench .editor-group-watermark .watermark-entry:hover { background-color: var(--fr-hover); }
.monaco-workbench .editor-group-watermark .watermark-entry:active { background-color: var(--fr-press); }
.monaco-workbench .editor-group-watermark .watermark-entry .watermark-label { flex: 1 1 auto; text-align: left; }
/* A hairline under the editor's tabs, at the same 35px as the rule under Friday's chat tabs beside it, so the two run as one line
   across the window (Arun, 2026-11-19: "line up this horizontal line too"). */
.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-and-actions-container { box-shadow: inset 0 -1px 0 var(--fr-border); }
.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs-and-actions-container .tab.active { box-shadow: none; }

/* The editor's inline actions (a merge conflict's Accept Current / Accept Incoming / Accept Both / Compare, a test's Run, references)
   as chips with a fill, not faint grey words easy to miss (Arun, 2026-11-19: "make this more visible i missed it"). The " | " between
   them is dropped: the chips stand apart on their own. */
.monaco-editor .codelens-decoration { font-size: 0 !important; overflow: visible !important; }
.monaco-editor .codelens-decoration > span { display: none !important; }
.monaco-editor .codelens-decoration > a { display: inline-block; margin: 1px 6px 0 0; padding: 0 9px; border-radius: 6px; background-color: var(--fr-press); color: var(--fr-ink) !important; font-size: 11.5px !important; font-weight: 500; line-height: 18px !important; text-decoration: none !important; }
.monaco-editor .codelens-decoration > a:hover { background-color: color-mix(in srgb, var(--fr-ink) 18%, transparent); color: var(--fr-ink) !important; }
/* A merge conflict's actions as one banner that can't be missed (Arun, 2026-11-19: "need a cleaner and beautiful design", "still
   ugly and gets overseen"): "Merge conflict" in amber, then Keep current (the band's green), Keep incoming (its blue), Keep both,
   and Compare as a link. VS Code's long labels are replaced by short ones; what each runs is VS Code's own. Told apart from other
   inline actions by there being four. */
.monaco-editor .codelens-decoration.fr-conflict { display: inline-flex !important; align-items: center; gap: 5px; height: 22px; margin-top: 1px; padding: 0 3px 0 10px; border-radius: 8px; background-color: var(--fr-conflict-bg); box-shadow: inset 0 0 0 1px var(--fr-conflict-line); }
.monaco-editor .codelens-decoration.fr-conflict::before { content: "Merge conflict"; margin-right: 6px; padding-left: 13px; color: var(--fr-conflict-ink); font: 600 11.5px/22px var(--vscode-font-family, system-ui); background: radial-gradient(circle at 3.5px 50%, var(--fr-conflict-ink) 3.2px, transparent 3.7px); }
.monaco-editor .codelens-decoration.fr-conflict > a { margin: 0 !important; padding: 0 10px !important; height: 18px; border-radius: 6px; font-size: 0 !important; line-height: 18px !important; }
.monaco-editor .codelens-decoration.fr-conflict > a::after { font: 500 11.5px/18px var(--vscode-font-family, system-ui); }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(1)::after { content: "Keep current"; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(2)::after { content: "Keep incoming"; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(3)::after { content: "Keep both"; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(4)::after { content: "Compare"; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(1) { background-color: #2f9e64 !important; color: #fff !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(2) { background-color: #3f73e0 !important; color: #fff !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(3) { background-color: var(--fr-press) !important; color: var(--fr-ink) !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(4) { background-color: transparent !important; color: var(--fr-muted) !important; padding: 0 7px !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(1):hover { background-color: #36b373 !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(2):hover { background-color: #4f82ee !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(3):hover { background-color: color-mix(in srgb, var(--fr-ink) 16%, transparent) !important; }
.monaco-editor .codelens-decoration.fr-conflict > a:nth-of-type(4):hover { color: var(--fr-ink) !important; text-decoration: underline !important; text-underline-offset: 3px; }
/* The actions above a function (Arun, 2026-11-19: "Inline actions above functions: Explain · Test · Fix · Refactor"): the skin
   script tags their row fr-lens. Quiet until hovered: muted words with no chip, each link lit as a chip under the pointer, the
   star in Claude's orange. Without the tag (a merge conflict's row, a test's Run) the chips above stay as they were. */
.monaco-editor .codelens-decoration.fr-lens > a { margin: 1px 1px 0 0; padding: 0 7px; background-color: transparent; color: var(--fr-muted) !important; font-size: 11.5px !important; }
.monaco-editor .codelens-decoration.fr-lens:hover > a { background-color: color-mix(in srgb, var(--fr-press) 60%, transparent); color: var(--fr-ink) !important; }
.monaco-editor .codelens-decoration.fr-lens > a:hover { background-color: var(--fr-press); color: var(--fr-ink) !important; }
.monaco-editor .codelens-decoration.fr-lens > a.fr-star::first-letter { color: #d97757; }

/* Friday's own rows above and below VS Code's (FRIDAY_SKIN_JS): Open File, Open Folder, and the recent folders. */
.monaco-workbench .editor-group-watermark .fr-rows { display: flex; flex-direction: column; gap: 2px; }
.monaco-workbench .editor-group-watermark .fr-rows.fr-start { margin-bottom: 2px; }
.monaco-workbench .editor-group-watermark .fr-recent-h { margin: 18px 10px 6px; color: var(--fr-muted); font-size: 12px; font-weight: 500; text-align: left; }
.monaco-workbench .editor-group-watermark .fr-row { display: flex; align-items: center; gap: 10px; box-sizing: border-box; min-width: 260px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color 120ms ease; }
.monaco-workbench .editor-group-watermark .fr-row:hover { background-color: var(--fr-hover); }
.monaco-workbench .editor-group-watermark .fr-row:active { background-color: var(--fr-press); }
.monaco-workbench .editor-group-watermark .fr-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.monaco-workbench .editor-group-watermark .fr-row .codicon { flex: none; width: 16px; font-size: 16px; opacity: .85; }
.monaco-workbench .editor-group-watermark .fr-row .fr-name { flex: none; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.monaco-workbench .editor-group-watermark .fr-row .fr-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: right; color: var(--fr-muted); font-size: 12px; }
.monaco-workbench .editor-group-watermark .monaco-keybinding-key { border: 0 !important; box-shadow: none !important; background-color: var(--fr-key) !important; border-radius: 5px; }
`;

/**
 * The empty editor's own rows (Arun, 2026-11-19: "also list recent projects opened and open folder and open file and stuff"): Open
 * File and Open Folder above VS Code's shortcuts, the folders opened lately below. Friday's page knows the folders, so it sends
 * them (postMessage, only from the window that holds this frame) and is told which was clicked; a folder opens through Friday, which
 * starts VS Code on it, as Open Folder does. Text only, never markup, from the page.
 */
export const FRIDAY_SKIN_JS = `(() => {
  "use strict";
  let recents = [];
  let current = "";
  const tell = (msg) => { try { window.parent.postMessage(Object.assign({ fridayVsc: 1 }, msg), "*"); } catch {} };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const row = (icon, label, path, onClick) => {
    const b = el("button", "fr-row");
    b.type = "button";
    b.appendChild(el("span", "codicon codicon-" + icon));
    b.appendChild(el("span", "fr-name", label));
    if (path) { const p = el("span", "fr-path"); p.appendChild(el("bdi", "", path)); b.appendChild(p); b.title = path; }
    b.addEventListener("click", onClick);
    return b;
  };
  const home = (p) => p.replace(/^\\/(Users|home)\\/[^/]+/, "~");
  const paint = (box) => {
    box.querySelectorAll(".fr-rows, .fr-recent-h").forEach((n) => n.remove());
    const start = el("div", "fr-rows fr-start");
    start.appendChild(row("go-to-file", "Open File", "", () => tell({ kind: "open-file" })));
    start.appendChild(row("folder-opened", "Open Folder", "", () => tell({ kind: "open-folder" })));
    box.insertBefore(start, box.firstChild);
    const list = recents.filter((r) => r.path !== current).slice(0, 5);
    if (!list.length) return;
    box.appendChild(el("div", "fr-recent-h", "Recent"));
    const rec = el("div", "fr-rows fr-recent");
    for (const r of list) rec.appendChild(row("folder", r.name, home(r.path), () => tell({ kind: "open-recent", path: r.path })));
    box.appendChild(rec);
  };
  const sweep = () => {
    document.querySelectorAll(".editor-group-watermark .watermark-box").forEach((box) => {
      const want = JSON.stringify([current, recents]);
      if (box.dataset.fr === want && box.querySelector(".fr-start")) return;
      box.dataset.fr = want;
      paint(box);
    });
  };
  // The pick lists under Friday's search pill (Arun, 2026-11-19: "make sure this always appears centered... whatever the layout
  // is"): the pill's middle, in this frame's pixels, sent by Friday; VS Code centres them in the frame, so they are moved by the
  // difference, never past the frame's edges. VS Code's own width for them: 62% of the window, 600px at most.
  let pillX = null;
  const centre = () => {
    const root = document.documentElement;
    if (pillX === null) return root.style.removeProperty("--fr-qi-x");
    const w = Math.min(600, innerWidth * 0.62);
    const room = Math.max(0, (innerWidth - w) / 2 - 8);
    const shift = Math.max(-room, Math.min(room, pillX - innerWidth / 2));
    root.style.setProperty("--fr-qi-x", Math.round(shift) + "px");
  };
  addEventListener("resize", centre);
  // Where the editor area is in this frame, told to Friday: its search pill is centred over it, over the empty editor's mark and
  // whatever is open, as the side bar and the agent column come and go (Arun, 2026-11-19: "make sure the search bar is centered").
  let lastEditor = "";
  const sayEditor = () => {
    const ed = document.querySelector(".monaco-workbench .part.editor");
    if (!ed) return;
    const r = ed.getBoundingClientRect();
    const now = Math.round(r.left) + ":" + Math.round(r.width);
    if (now === lastEditor || r.width <= 0) return;
    lastEditor = now;
    tell({ kind: "editor-box", left: r.left, width: r.width });
  };
  let watched = null;
  const watchEditor = () => {
    const ed = document.querySelector(".monaco-workbench .part.editor");
    if (!ed || ed === watched) return;
    watched = ed;
    new ResizeObserver(sayEditor).observe(ed);
    sayEditor();
  };
  addEventListener("resize", sayEditor);
  // The right side bar's box, told to Friday: its chat lies exactly over it, above the status bar, so the status bar is the
  // window's one footer and the bar's own edge resizes the chat (Arun, 2026-11-20: "the native vscode footer needs to the be
  // running across the full length of the footer"). Sent on every change of place, size or showing.
  let lastAux = "";
  const sayAux = () => {
    const aux = document.querySelector(".monaco-workbench .part.auxiliarybar");
    const r = aux && aux.getBoundingClientRect();
    const shown = !!r && r.width > 0 && r.height > 0 && getComputedStyle(aux).display !== "none" && getComputedStyle(aux).visibility !== "hidden";
    const box = shown ? { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } : null;
    const now = JSON.stringify(box);
    if (now === lastAux) return;
    lastAux = now;
    // The IDE's notices sit in its bottom right corner, which the chat now covers: they move to beside it.
    document.documentElement.style.setProperty("--fr-aux-w", (box ? box.width : 0) + "px");
    tell({ kind: "aux", box });
  };
  let auxWatched = null;
  const auxSizes = new ResizeObserver(() => sayAux());
  const watchAux = () => {
    const aux = document.querySelector(".monaco-workbench .part.auxiliarybar");
    if (aux && aux !== auxWatched) {
      auxWatched = aux;
      auxSizes.observe(aux);
    }
    sayAux();
  };
  addEventListener("resize", sayAux);
  // The bar to a width Friday asks for (the chat's own, kept between runs): the IDE keeps the bar's size itself and has no command
  // to set it, so its edge is dragged there once, as a person would.
  const sizeAux = (want) => {
    const aux = document.querySelector(".monaco-workbench .part.auxiliarybar");
    const r = aux && aux.getBoundingClientRect();
    if (!r || r.width <= 0 || !(want > 0) || Math.abs(want - r.width) < 4) return;
    const sash = Array.from(document.querySelectorAll(".monaco-workbench .monaco-sash.vertical")).find((el) => {
      const b = el.getBoundingClientRect();
      return b.height > 100 && Math.abs(b.left + b.width / 2 - r.left) < 6;
    });
    if (!sash) return;
    const b = sash.getBoundingClientRect();
    const y = b.top + b.height / 2;
    const from = b.left + b.width / 2;
    const to = from - (want - r.width);
    // The sash follows the mouse (mousedown on it, then moves and the release on the window).
    const ev = (type, x, buttons) => new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons, detail: 1 });
    try {
      sash.dispatchEvent(ev("mousedown", from, 1));
      for (const t of [from + (to - from) / 2, to]) window.dispatchEvent(ev("mousemove", t, 1));
      window.dispatchEvent(ev("mouseup", to, 0));
    } catch {
      // The IDE took no drag it didn't see a pointer for: the bar keeps its size.
    }
  };
  // Keys pressed in an editor, said to Friday at most every 2 seconds: its pings wait for a pause (Arun, 2026-11-19, wave 4: "while
  // you're typing in the editor, Friday holds its pings"). Only real keys, from the keyboard: an agent's edits are not typing.
  let lastTyped = 0;
  document.addEventListener("keydown", (e) => {
    // Printable keys and Backspace, Delete, Enter, in a file's editor: not arrows, Tab, F-keys, nor the find box, the Source Control
    // message or the search boxes, which are Monaco too.
    if (e.ctrlKey || e.metaKey || e.altKey || !e.isTrusted || !(e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter")) return;
    const t = e.target;
    if (!t || !t.closest || !t.closest(".editor-instance .monaco-editor") || t.closest(".find-widget, .suggest-widget, .scm-editor, .monaco-inputbox, .quick-input-widget")) return;
    const now = Date.now();
    if (now - lastTyped < 2000) return;
    lastTyped = now;
    tell({ kind: "typing" });
  }, true);
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.fridayVsc !== 1) return;
    if (e.data.kind === "pill") {
      pillX = typeof e.data.x === "number" && isFinite(e.data.x) ? e.data.x : null;
      return centre();
    }
    if (e.data.kind === "aux-width") return sizeAux(Number(e.data.width));
    if (e.data.kind !== "recents") return;
    const ok = (s) => typeof s === "string" && s.length < 2000;
    recents = Array.isArray(e.data.folders) ? e.data.folders.filter((f) => f && ok(f.path) && ok(f.name)).slice(0, 12) : [];
    // Friday's app has the system's open panel: VS Code's Open buttons use it (nativePickers).
    if (e.data.native === true) window.__fridayPick = (what) => tell({ kind: "pick", what: String(what) });
    else delete window.__fridayPick;
    current = ok(e.data.current) ? e.data.current : "";
    sweep();
  });
  // (Friday IDE ships in English only, so the conflict row is told by its English "Accept ..." links.)
  // A row of editor actions, told by what its links say: a merge conflict's ("Accept Current Change"...) is the banner (fr-conflict),
  // Friday's own over a function ("Explain", "Test", "Fix", "Refactor") the quiet row (fr-lens). The class is set on every look, so
  // a row the editor reuses for other links loses the one it had.
  const tagLenses = () => {
    document.querySelectorAll(".monaco-editor .codelens-decoration").forEach((d) => {
      const links = Array.from(d.children).filter((c) => c.tagName === "A").map((a) => a.textContent || "");
      d.classList.toggle("fr-conflict", links.some((t) => /^Accept /.test(t)) && links.length >= 4);
      // Any pair in the row, since other providers' lenses (references, GitLens, test runners, the coverage row) share it and may sort first.
      d.querySelectorAll(":scope > a").forEach((a) => a.classList.toggle("fr-star", /^\u2733 (?:Explain|Do this|Test [0-9]+ uncovered lines?)$/.test(a.textContent || "")));
      d.classList.toggle("fr-lens", (links.some((t) => /^(\u2733 )?Explain$/.test(t)) && links.includes("Test")) || links.some((t) => /^(\u2733 )?Test [0-9]+ uncovered lines?$/.test(t)) || links.includes("\u2733 Do this"));
    });
  };
  new MutationObserver(() => (sweep(), watchEditor(), watchAux(), tagLenses())).observe(document.documentElement, { childList: true, subtree: true });
  tell({ kind: "hello" });
})();
`;

/**
 * Pick-list rows a little taller (Arun, 2026-11-19: "add better spacing and stuff too please", of the branch picker): VS Code
 * places its rows by a fixed height per kind (a group heading 30, a row with a detail line 44, a plain row 22), so those numbers
 * are raised in the build, 34, 52 and 30, and the skin centres each row's contents in its height. A build without the line keeps its own.
 */
export function roomierPickLists(js: string): string {
  return js.replace(/getHeight\((\w+)\)\{return \1 instanceof (\w+)\?30:\1\.saneDetail\?44:22\}/, "getHeight($1){return $1 instanceof $2?34:$1.saneDetail?52:30}");
}

/**
 * The Extensions view's Installed list as one plain "Installed" (Arun, 2026-11-19: "get rid of this 127.0.0.1:XXXXX installed
 * thing"): code-server serves VS Code as a remote, so its list was titled with the server's address, beside an empty "Browser -
 * Installed" list for in-browser extensions Friday doesn't use. A build without these lines keeps its own titles.
 */
export function plainInstalledList(js: string): string {
  return js
    .replace(/let (\w)=\((\w),(\w)\)=>(\w)\.length>1\?`\$\{\3\.label\} - \$\{\2\}`:\2,/, "let $1=($2,$3)=>$2,")
    .replace(/for\(let (\w) of (\w)\)\{let (\w)=\(\)=>(\w)\(d\((\d+),null\),\1\)/, 'for(let $1 of $2.filter(s=>s.id!=="web"||$2.length===1)){let $3=()=>$4(d($5,null),$1)');
}

/**
 * Recommended extensions (Arun, 2026-11-19: "also show recommended extensions too"): code-server's product file has none, so the
 * Recommended list stayed empty. VS Code's own rule, the language of a file opened, with a reviewed set from Open VSX (the gallery
 * Friday uses), each one the language's usual choice.
 */
export const RECOMMENDED_EXTENSIONS: Record<string, string[]> = {
  "ms-python.python": ["python"],
  "golang.Go": ["go"],
  "rust-lang.rust-analyzer": ["rust"],
  "redhat.java": ["java"],
  "llvm-vs-code-extensions.vscode-clangd": ["c", "cpp"],
  "dbaeumer.vscode-eslint": ["javascript", "typescript", "javascriptreact", "typescriptreact"],
  "esbenp.prettier-vscode": ["javascript", "typescript", "javascriptreact", "typescriptreact", "css", "scss", "html", "json", "markdown"],
  "bradlc.vscode-tailwindcss": ["css", "html", "javascriptreact", "typescriptreact"],
  "Vue.volar": ["vue"],
  "svelte.svelte-vscode": ["svelte"],
  "ms-azuretools.vscode-docker": ["dockerfile", "dockercompose"],
  "redhat.vscode-yaml": ["yaml"],
  "tamasfe.even-better-toml": ["toml"],
  "yzhang.markdown-all-in-one": ["markdown"],
  "Prisma.prisma": ["prisma"],
  "hashicorp.terraform": ["terraform"],
  "Shopify.ruby-lsp": ["ruby"],
  "bmewburn.vscode-intelephense-client": ["php"],
  "Dart-Code.dart-code": ["dart"],
  "swiftlang.swift-vscode": ["swift"],
  "fwcd.kotlin": ["kotlin"],
};
async function recommendExtensions(dir: string): Promise<void> {
  const file = path.join(dir, "lib", "vscode", "product.json");
  let product: Record<string, unknown>;
  try {
    product = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!product.extensionRecommendations) {
    product.extensionRecommendations = Object.fromEntries(Object.entries(RECOMMENDED_EXTENSIONS).map(([id, languages]) => [id, { onFileOpen: [{ languages }] }]));
    await writeFile(file, JSON.stringify(product, null, "\t"));
  }
  // code-server hands the page a fixed few of the product's settings; the recommendations are added to them.
  const server = path.join(dir, "lib", "vscode", "out", "server-main.js");
  const js = await readFile(server, "utf8").catch(() => null);
  if (js === null || js.includes("extensionRecommendations:this._productService.extensionRecommendations")) return;
  const next = js.replace(/extensionsGallery:this\._productService\.extensionsGallery,linkProtectionTrustedDomains:(\w+)\}/, "extensionsGallery:this._productService.extensionsGallery,extensionRecommendations:this._productService.extensionRecommendations,linkProtectionTrustedDomains:$1}");
  if (next !== js) await writeFile(server, next);
}

/**
 * VS Code's Open Folder, Open… and Open File… open the system's own picker inside Friday's app (Arun, 2026-11-19: "the VScode
 * native open folder needs to open up finder"), not the in-window list the web build has: each starts by handing over to Friday
 * (the skin's script, globalThis.__fridayPick) when Friday has said it can. Elsewhere (a browser) they are VS Code's as they were.
 */
export function nativePickers(js: string): string {
  const hook = (name: string, what: string) => (s: string) =>
    s.includes(`async ${name}(o){if(globalThis.__fridayPick`) ? s : s.replace(`async ${name}(o){`, `async ${name}(o){if(globalThis.__fridayPick)return globalThis.__fridayPick("${what}");`);
  return [hook("pickFolderAndOpen", "folder"), hook("pickFileFolderAndOpen", "any"), hook("pickFileAndOpen", "file")].reduce((s, f) => f(s), js);
}

/** The stylesheet beside the workbench's own, and the workbench page linking it. Run again on a build that has it: nothing changes. */
export async function applySkin(dir: string): Promise<void> {
  const wb = path.join(dir, "lib", "vscode", "out", "vs", "code", "browser", "workbench");
  const html = path.join(wb, "workbench.html");
  if (!existsSync(html)) return;
  await writeFile(path.join(wb, "friday.css"), FRIDAY_SKIN_CSS);
  await writeFile(path.join(wb, "friday.js"), FRIDAY_SKIN_JS);
  let page = await readFile(html, "utf8");
  const before = page;
  const link = `<link rel="stylesheet" href="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/workbench.css">`;
  if (!page.includes("/workbench/friday.css") && page.includes(link)) page = page.replace(link, `${link}\n\t\t<link rel="stylesheet" href="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/friday.css">`);
  // Its own file, from the page's origin: code-server's policy allows 'self' scripts and nothing inline without its nonce.
  if (!page.includes("/workbench/friday.js") && page.includes("</html>")) page = page.replace("</html>", `\t<script src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/friday.js"></script>\n</html>`);
  if (page !== before) await writeFile(html, page);
  const jsFile = path.join(wb, "workbench.js");
  const js = await readFile(jsFile, "utf8").catch(() => null);
  await recommendExtensions(dir);
  if (js !== null) {
    const next = nativePickers(plainInstalledList(roomierPickLists(js)));
    if (next !== js) await writeFile(jsFile, next);
  }
}
