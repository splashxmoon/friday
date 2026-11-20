// What Friday's one search hands on to the IDE's own searches (Arun, 2026-11-20: "Search symbols in the IDE" and "Search text in
// files" entries that hand off to the IDE's own #symbol quick open, Find in Files with the query). Run by extension.js when the
// runner's bridge/command.json asks for friday.searchSymbols or friday.searchText.

/** The IDE's quick open in its symbol mode ("#"), with the words already typed. */
async function symbols(vscode, query) {
  await vscode.commands.executeCommand("workbench.action.quickOpen", "#" + String(query || ""));
}

/** Find in Files, opened with the words and run at once: plain text, not a pattern. */
async function text(vscode, query) {
  await vscode.commands.executeCommand("workbench.action.findInFiles", { query: String(query || ""), triggerSearch: true, isRegex: false, isCaseSensitive: false, matchWholeWord: false });
}

module.exports = { symbols, text };
