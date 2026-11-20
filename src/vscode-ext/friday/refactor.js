"use strict";
// Refactor across the codebase (Arun, 2026-11-19: "rename a concept, move a module, change an API — the agent plans every file
// first, you approve, it does them all and shows one review"): "Friday: Refactor across the codebase…" asks what to change (the
// word under the cursor already in the box) and sends it to Friday's column as a "restructure" ask, which starts a chat that plans
// first (src/client/refactor-plan.ts). Plain CommonJS; the vscode API is passed in so a test can hand it a stand-in.

/** The word under the cursor of the active editor, or "" (a selection, if there is one and it is a single short line, wins). */
function symbolAtCursor(vscode) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !ed.document || !ed.selection) return "";
  try {
    const sel = ed.selection;
    if (!sel.isEmpty && sel.isSingleLine) {
      const t = ed.document.getText(sel).trim();
      if (t && t.length <= 80) return t;
    }
    const r = ed.document.getWordRangeAtPosition(sel.active);
    return r ? ed.document.getText(r).trim().slice(0, 80) : "";
  } catch {
    return "";
  }
}

function register(vscode, context, postAsk, rootOf) {
  if (!vscode.commands || !vscode.commands.registerCommand) return;
  // `given`: the change already worded (a caller that has it skips the box).
  const run = async (given) => {
    const ed = vscode.window.activeTextEditor;
    const symbol = symbolAtCursor(vscode);
    let change = typeof given === "string" ? given.trim() : "";
    if (!change) {
      if (!vscode.window.showInputBox) return;
      const asked = await vscode.window.showInputBox({
        title: "Refactor across the codebase",
        prompt: "The agent plans every file first. Nothing changes until you say go ahead.",
        placeHolder: "Rename a concept, move a module, change an API",
        // The symbol under the cursor starts the sentence: finish it, or replace it.
        ...(symbol ? { value: `Rename ${symbol} to `, valueSelection: [`Rename ${symbol} to `.length, `Rename ${symbol} to `.length] } : {}),
        ignoreFocusOut: true,
      });
      change = (asked || "").trim();
      // Left as it was offered: nothing was said to change.
      if (!change || (symbol && change === `Rename ${symbol} to`)) return;
    }
    // A file on disk only: a git: or output: view, a diff's side or an untitled buffer has no path the folder knows.
    const doc = ed && ed.document && ed.document.uri && ed.document.uri.scheme === "file" ? ed.document : null;
    const root = (doc && rootOf(doc.uri)) || (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : "");
    const line = doc && ed.selection ? ed.selection.active.line + 1 : 1;
    return postAsk({ kind: "restructure", path: doc ? doc.uri.fsPath : "", from: line, to: line, text: "", root, problem: change.slice(0, 2000), source: "the IDE", ...(symbol ? { symbol, symbolKind: "" } : {}) });
  };
  context.subscriptions.push(vscode.commands.registerCommand("friday.refactorAcross", run));
}

module.exports = { register, symbolAtCursor };
