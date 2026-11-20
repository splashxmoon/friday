/**
 * VS Code's menus, in the Mac menu bar while Code is showing (Arun, 2026-11-19: "make sure when we are in ide platform, it will
 * have these" — File, Edit, Selection, View, Go, Run, Terminal, Window, Help — "for the VScode platform"). One list for both
 * ends: the desktop app builds the menu bar from it (src/local/desktop.ts), and the runner lets VS Code be asked to run exactly
 * these commands (src/runner/vscode.ts vscodeCommand).
 *
 * The shortcuts are shown, not taken: each item is registerAccelerator: false, so a key still reaches VS Code (or Friday) as it
 * always did, and the menu says what it is. Cut, Copy, Paste and the Window menu are the system's own roles.
 */

/** What Friday does itself rather than VS Code: its folder picker, closing the folder, the agent column. */
export type VsMenuFriday = "open-folder" | "close-folder" | "agent" | "new-window" | "new-agent-window";

export type VsMenuItem =
  | { sep: true }
  | { role: "cut" | "copy" | "paste" | "close" }
  | { label: string; command: string; key?: string }
  | { label: string; friday: VsMenuFriday; key?: string }
  | { label: string; submenu: VsMenuItem[] }
  /** Open Recent's folders, filled in by the app from the ones Friday knows (desktop.ts setMenus). */
  | { recent: true };

export interface VsMenu {
  label: string;
  items: VsMenuItem[];
}

const S = { sep: true } as const;

export const VSCODE_MENUS: VsMenu[] = [
  {
    label: "File",
    // VS Code's own File menu, item for item (Arun, 2026-11-19: "file needs to have all of these"). Friday is one window, so a new
    // window is VS Code's empty one, and a new agent window is a new thread in Agents.
    items: [
      { label: "New Text File", command: "workbench.action.files.newUntitledFile", key: "CmdOrCtrl+N" },
      { label: "New File…", command: "welcome.showNewFileEntries", key: "Ctrl+Alt+Command+N" },
      { label: "New Window", friday: "new-window", key: "CmdOrCtrl+Shift+N" },
      {
        label: "New Window with Profile",
        submenu: [
          { label: "New Profile…", command: "workbench.profiles.actions.createProfile" },
          { label: "Switch Profile…", command: "workbench.profiles.actions.switchProfile" },
          { label: "Profiles", command: "workbench.profiles.actions.manageProfiles" },
        ],
      },
      { label: "New Agent Window", friday: "new-agent-window" },
      S,
      { label: "Open…", command: "workbench.action.files.openFile", key: "CmdOrCtrl+O" },
      { label: "Open Folder…", friday: "open-folder" },
      { label: "Open Workspace from File…", command: "workbench.action.openWorkspace" },
      { label: "Open Recent", submenu: [{ recent: true }, S, { label: "More…", command: "workbench.action.openRecent", key: "Ctrl+R" }] },
      S,
      { label: "Add Folder to Workspace…", command: "workbench.action.addRootFolder" },
      { label: "Save Workspace As…", command: "workbench.action.saveWorkspaceAs" },
      { label: "Duplicate Workspace", command: "workbench.action.duplicateWorkspaceInNewWindow" },
      S,
      { label: "Save", command: "workbench.action.files.save", key: "CmdOrCtrl+S" },
      { label: "Save As…", command: "workbench.action.files.saveAs", key: "CmdOrCtrl+Shift+S" },
      { label: "Save All", command: "workbench.action.files.saveAll", key: "CmdOrCtrl+Alt+S" },
      S,
      {
        label: "Share",
        submenu: [
          { label: "Copy Path of Active File", command: "workbench.action.files.copyPathOfActiveFile", key: "CmdOrCtrl+Alt+C" },
          { label: "Copy Relative Path of Active File", command: "copyRelativeFilePath" },
          { label: "Export Profile…", command: "workbench.profiles.actions.exportProfile" },
        ],
      },
      S,
      { label: "Auto Save", command: "workbench.action.toggleAutoSave" },
      S,
      { label: "Revert File", command: "workbench.action.files.revert" },
      { label: "Close Editor", command: "workbench.action.closeActiveEditor", key: "CmdOrCtrl+W" },
      { label: "Close Folder", friday: "close-folder" },
      { role: "close" },
    ],
  },
  {
    label: "Edit",
    items: [
      { label: "Undo", command: "undo", key: "CmdOrCtrl+Z" },
      { label: "Redo", command: "redo", key: "CmdOrCtrl+Shift+Z" },
      S,
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      S,
      { label: "Find", command: "actions.find", key: "CmdOrCtrl+F" },
      { label: "Replace", command: "editor.action.startFindReplaceAction", key: "CmdOrCtrl+Alt+F" },
      S,
      { label: "Find in Files", command: "workbench.action.findInFiles", key: "CmdOrCtrl+Shift+F" },
      { label: "Replace in Files", command: "workbench.action.replaceInFiles", key: "CmdOrCtrl+Shift+H" },
      S,
      { label: "Toggle Line Comment", command: "editor.action.commentLine", key: "CmdOrCtrl+/" },
      { label: "Toggle Block Comment", command: "editor.action.blockComment", key: "Shift+Alt+A" },
    ],
  },
  {
    label: "Selection",
    items: [
      { label: "Select All", command: "editor.action.selectAll", key: "CmdOrCtrl+A" },
      { label: "Expand Selection", command: "editor.action.smartSelect.expand", key: "Ctrl+Shift+Command+Right" },
      { label: "Shrink Selection", command: "editor.action.smartSelect.shrink", key: "Ctrl+Shift+Command+Left" },
      S,
      { label: "Copy Line Up", command: "editor.action.copyLinesUpAction", key: "Shift+Alt+Up" },
      { label: "Copy Line Down", command: "editor.action.copyLinesDownAction", key: "Shift+Alt+Down" },
      { label: "Move Line Up", command: "editor.action.moveLinesUpAction", key: "Alt+Up" },
      { label: "Move Line Down", command: "editor.action.moveLinesDownAction", key: "Alt+Down" },
      { label: "Duplicate Selection", command: "editor.action.duplicateSelection" },
      S,
      { label: "Add Cursor Above", command: "editor.action.insertCursorAbove", key: "CmdOrCtrl+Alt+Up" },
      { label: "Add Cursor Below", command: "editor.action.insertCursorBelow", key: "CmdOrCtrl+Alt+Down" },
      { label: "Add Cursors to Line Ends", command: "editor.action.insertCursorAtEndOfEachLineSelected", key: "Shift+Alt+I" },
      { label: "Add Next Occurrence", command: "editor.action.addSelectionToNextFindMatch", key: "CmdOrCtrl+D" },
      { label: "Select All Occurrences", command: "editor.action.selectHighlights", key: "CmdOrCtrl+Shift+L" },
    ],
  },
  {
    label: "View",
    items: [
      { label: "Command Palette…", command: "workbench.action.showCommands", key: "CmdOrCtrl+Shift+P" },
      { label: "Open View…", command: "workbench.action.openView" },
      S,
      { label: "Explorer", command: "workbench.view.explorer", key: "CmdOrCtrl+Shift+E" },
      { label: "Search", command: "workbench.view.search", key: "CmdOrCtrl+Shift+F" },
      { label: "Source Control", command: "workbench.view.scm", key: "Ctrl+Shift+G" },
      { label: "Run", command: "workbench.view.debug", key: "CmdOrCtrl+Shift+D" },
      { label: "Extensions", command: "workbench.view.extensions", key: "CmdOrCtrl+Shift+X" },
      S,
      { label: "Problems", command: "workbench.actions.view.problems", key: "CmdOrCtrl+Shift+M" },
      { label: "Output", command: "workbench.action.output.toggleOutput", key: "CmdOrCtrl+Shift+U" },
      { label: "Debug Console", command: "workbench.debug.action.toggleRepl", key: "CmdOrCtrl+Shift+Y" },
      { label: "Terminal", command: "workbench.action.terminal.toggleTerminal", key: "Ctrl+`" },
      S,
      { label: "Toggle Side Bar", command: "workbench.action.toggleSidebarVisibility", key: "CmdOrCtrl+B" },
      { label: "Toggle Panel", command: "workbench.action.togglePanel", key: "CmdOrCtrl+J" },
      { label: "Toggle Agent", friday: "agent", key: "CmdOrCtrl+Alt+B" },
      S,
      { label: "Word Wrap", command: "editor.action.toggleWordWrap", key: "Alt+Z" },
      { label: "Minimap", command: "editor.action.toggleMinimap" },
    ],
  },
  {
    label: "Go",
    items: [
      { label: "Back", command: "workbench.action.navigateBack", key: "Ctrl+-" },
      { label: "Forward", command: "workbench.action.navigateForward", key: "Ctrl+Shift+-" },
      S,
      { label: "Go to File…", command: "workbench.action.quickOpen", key: "CmdOrCtrl+P" },
      { label: "Go to Symbol in Workspace…", command: "workbench.action.showAllSymbols", key: "CmdOrCtrl+T" },
      { label: "Go to Symbol in Editor…", command: "workbench.action.gotoSymbol", key: "CmdOrCtrl+Shift+O" },
      { label: "Go to Definition", command: "editor.action.revealDefinition", key: "F12" },
      { label: "Go to References", command: "editor.action.goToReferences", key: "Shift+F12" },
      { label: "Go to Line/Column…", command: "workbench.action.gotoLine", key: "Ctrl+G" },
      { label: "Go to Bracket", command: "editor.action.jumpToBracket", key: "CmdOrCtrl+Shift+\\" },
      S,
      { label: "Next Problem", command: "editor.action.marker.nextInFiles", key: "F8" },
      { label: "Previous Problem", command: "editor.action.marker.prevInFiles", key: "Shift+F8" },
    ],
  },
  {
    label: "Run",
    items: [
      { label: "Start Debugging", command: "workbench.action.debug.start", key: "F5" },
      { label: "Run Without Debugging", command: "workbench.action.debug.run", key: "Ctrl+F5" },
      { label: "Stop Debugging", command: "workbench.action.debug.stop", key: "Shift+F5" },
      { label: "Restart Debugging", command: "workbench.action.debug.restart", key: "Shift+CmdOrCtrl+F5" },
      S,
      { label: "Open Configurations", command: "workbench.action.debug.configure" },
      { label: "Add Configuration…", command: "debug.addConfiguration" },
      S,
      { label: "Toggle Breakpoint", command: "editor.debug.action.toggleBreakpoint", key: "F9" },
    ],
  },
  {
    label: "Terminal",
    items: [
      { label: "New Terminal", command: "workbench.action.terminal.new", key: "Ctrl+Shift+`" },
      { label: "Split Terminal", command: "workbench.action.terminal.split", key: "CmdOrCtrl+\\" },
      S,
      { label: "Run Task…", command: "workbench.action.tasks.runTask" },
      { label: "Run Build Task…", command: "workbench.action.tasks.build", key: "CmdOrCtrl+Shift+B" },
      { label: "Run Active File", command: "workbench.action.terminal.runActiveFile" },
      { label: "Run Selected Text", command: "workbench.action.terminal.runSelectedText" },
      S,
      { label: "Configure Tasks…", command: "workbench.action.tasks.configureTaskRunner" },
    ],
  },
];

/** VS Code's own Help items, before Friday's (Send Feedback). */
export const VSCODE_HELP: VsMenuItem[] = [
  { label: "Show All Commands", command: "workbench.action.showCommands", key: "CmdOrCtrl+Shift+P" },
  { label: "Editor Playground", command: "workbench.action.showInteractivePlayground" },
  { label: "Keyboard Shortcuts", command: "workbench.action.openGlobalKeybindings" },
];

/** Every VS Code command the menus can ask for, and VS Code's own Open Folder (Friday's in a browser, where there is no system picker). */
const commandsIn = (items: VsMenuItem[]): string[] => items.flatMap((i) => ("command" in i ? [i.command] : "submenu" in i ? commandsIn(i.submenu) : []));
export const VSCODE_MENU_COMMANDS: ReadonlySet<string> = new Set([
  ...commandsIn([...VSCODE_MENUS.flatMap((m) => m.items), ...VSCODE_HELP]),
  "workbench.action.files.openFolder",
]);
