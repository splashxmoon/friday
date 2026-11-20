"use strict";
// "Friday: Ask the codebase" (Arun, 2026-11-19, wave 2: "a question about how the code works, answered with the exact lines, from
// inside the IDE"). A quick input; the question goes to Friday as an ask of kind "question", and Friday's column answers it in a
// tab of its own (src/client/ide/ask-code.tsx) with the lines it cites as chips that open here. With code selected, the question
// takes the selection as context ("Ask about this selection").
const path = require("node:path");

const MAX_TEXT = 20000;

/** A quick input that resolves with the trimmed text, or undefined when it is dismissed. */
function ask(vscode, title, placeholder) {
  return new Promise((resolve) => {
    if (!vscode.window.createInputBox) return resolve(vscode.window.showInputBox ? vscode.window.showInputBox({ title, placeHolder: placeholder }) : undefined);
    const box = vscode.window.createInputBox();
    box.title = title;
    box.placeholder = placeholder;
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      resolve(v);
      box.dispose();
    };
    box.onDidAccept(() => end(box.value.trim() || undefined));
    box.onDidHide(() => end(undefined));
    box.show();
  });
}

/** The selected lines of the active editor, when some are selected in a file of the folder: { file, from, to, text }. */
function selectionOf(vscode) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !editor.document || editor.document.uri.scheme !== "file") return null;
  const sel = editor.selection;
  if (!sel || sel.isEmpty) return null;
  const doc = editor.document;
  // A selection that ends at the very start of a line doesn't take that line.
  const last = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  const text = doc.getText(new vscode.Range(sel.start.line, 0, last, doc.lineAt(last).range.end.character)).slice(0, MAX_TEXT);
  return { file: doc.uri.fsPath, from: sel.start.line + 1, to: last + 1, text };
}

/** The title the box carries: what it asks about. */
function boxTitle(sel) {
  if (!sel) return "✳ Ask the codebase";
  const lines = sel.to === sel.from ? `line ${sel.from}` : `lines ${sel.from}–${sel.to}`;
  return `✳ Ask the codebase about ${lines} of ${path.basename(sel.file)}`;
}

/** The ask posted to Friday: the question, the selection as its lines, and the folder the question is about. */
function questionAsk(question, sel, root) {
  return { kind: "question", instruction: question, path: sel ? sel.file : "", from: sel ? sel.from : 1, to: sel ? sel.to : 1, text: sel ? sel.text : "", root };
}

/**
 * `postAsk` sends an ask to Friday (extension.js); `rootOf(uri)` is the workspace folder a file is in, `roots()` the folders open.
 */
function register(vscode, context, postAsk, rootOf, roots) {
  const run = async () => {
    const sel = selectionOf(vscode);
    const root = (sel && rootOf(vscode.Uri.file(sel.file))) || roots()[0] || "";
    if (!root) return void vscode.window.showInformationMessage("Open a folder first, then ask about its code.");
    const question = await ask(vscode, boxTitle(sel), sel ? "What do you want to know about these lines?" : "How does login work? Where is a refund decided?");
    if (!question) return;
    if (await postAsk(questionAsk(question, sel, root))) vscode.window.setStatusBarMessage("✳ Asking the codebase…", 3000);
  };
  context.subscriptions.push(vscode.commands.registerCommand("friday.askCodebase", run));
  // The same box from the editor's menu when code is selected: its own title, as a menu entry's is its command's.
  context.subscriptions.push(vscode.commands.registerCommand("friday.askCodebaseSelection", run));
}

module.exports = { register, selectionOf, boxTitle, questionAsk };
