"use strict";
// Which files have unsaved edits in the IDE, told to Friday (Arun, 2026-11-19, wave 4: "Rewind an agent run… if the person has unsaved
// edits in a file the rewind touches, say so in the confirm and keep their buffer"). Friday's page asks before it rewinds a chat, and its
// confirm names the files going back that the person is still typing in. The IDE itself keeps a dirty buffer as it is when the file
// changes under it, and asks before saving over it, so nothing is lost; this only lets the page say so first.
//
// Posted when the set changes (after a pause in typing), and every 15 seconds while it isn't empty: Friday counts a list that stops
// coming as empty (src/vscode-dirty.ts), since a closed window can't clear its own.

const HEARTBEAT_MS = 15000;
const PAUSE_MS = 500;

/** A file's real path, or the same when it can't be resolved. */
function real(file) {
  try {
    return require("fs").realpathSync.native(file);
  } catch {
    return file;
  }
}

/** Which of the workspace's folders holds a file: the IDE's own answer, else the longest folder it is inside (that folder itself, not a sibling named the same up to its end). */
function rootOf(vscode, roots, d) {
  const own = vscode.workspace && vscode.workspace.getWorkspaceFolder && vscode.workspace.getWorkspaceFolder(d.uri);
  if (own && own.uri && own.uri.fsPath) return own.uri.fsPath;
  const f = d.uri.fsPath.replace(/\\/g, "/");
  const win = /^[a-z]:\//i.test(f);
  const inside = roots()
    .filter((r) => {
      const a = r.replace(/\\/g, "/").replace(/\/+$/, "");
      const x = win ? f.toLowerCase() : f;
      const y = win ? a.toLowerCase() : a;
      return x === y || x.startsWith(`${y}/`);
    })
    .sort((a, b) => b.length - a.length);
  return inside[0] || "";
}

/** The unsaved files of a workspace, relative to its folder: only real files, sorted so the same set always reads the same. Pure. */
function dirtyPaths(vscode, roots, relative) {
  return dirtyDocs(vscode, roots).map((x) => relative(x.root, x.file)).sort();
}

/** The same files with the folder each is in: [{ root, file }], file absolute. */
function dirtyDocs(vscode, roots) {
  const docs = (vscode.workspace && vscode.workspace.textDocuments) || [];
  const seen = new Map();
  for (const d of docs) {
    if (!d || !d.isDirty || !d.uri || (d.uri.scheme && d.uri.scheme !== "file" && d.uri.scheme !== "vscode-remote")) continue;
    seen.set(d.uri.fsPath, { root: rootOf(vscode, roots, d), file: d.uri.fsPath });
  }
  return [...seen.values()];
}

function register(vscode, context, { roots, relative, post }) {
  if (!vscode.workspace || !vscode.workspace.onDidChangeTextDocument) return { paths: () => [] };
  let last = "";
  let timer;
  let beat;
  const send = async () => {
    const docs = dirtyDocs(vscode, roots);
    const paths = docs.map((x) => relative(x.root, x.file)).sort();
    // Each file by the name the IDE gave it and by its real name: git says a repository's top by its real path, and a folder reached
    // through a link (macOS's /tmp, a symlinked project) would otherwise never match.
    const files = [...new Set(docs.flatMap((x) => [x.file, real(x.file)]).map((f) => f.replace(/\\/g, "/")))].sort();
    const key = JSON.stringify([paths, files]);
    // The same set is told again only by the heartbeat, and an empty one once (to clear what was said before).
    if (key === last && !paths.length) return;
    last = key;
    await post({ root: roots()[0] || "", paths, files });
    if (paths.length && !beat) {
      beat = setInterval(() => void send(), HEARTBEAT_MS);
      if (beat.unref) beat.unref();
    } else if (!paths.length && beat) {
      clearInterval(beat);
      beat = undefined;
    }
  };
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void send(), PAUSE_MS);
  };
  for (const ev of ["onDidChangeTextDocument", "onDidSaveTextDocument", "onDidCloseTextDocument"]) {
    if (vscode.workspace[ev]) context.subscriptions.push(vscode.workspace[ev](soon));
  }
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(timer);
      if (beat) clearInterval(beat);
    },
  });
  return { paths: () => dirtyPaths(vscode, roots, relative), flush: send };
}

/** Friday's POST /api/vscode/dirty, quiet when it can't be reached (nothing here is worth a warning). */
function poster(env) {
  return async (body) => {
    const base = env.FRIDAY_URL;
    const token = env.FRIDAY_VSCODE_TOKEN;
    if (!base || !token) return false;
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/dirty`, { method: "POST", headers: { "content-type": "application/json", "x-friday-vscode": token }, body: JSON.stringify(body) });
      return res.ok;
    } catch {
      return false;
    }
  };
}

module.exports = { register, dirtyPaths, dirtyDocs, poster };
