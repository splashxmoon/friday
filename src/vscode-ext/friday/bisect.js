"use strict";
// Find what broke in the IDE (Arun, 2026-11-19, wave 2: "Bisect: tell Friday what broke; an agent runs git bisect with a test it
// writes or the one you give, and hands back the commit that broke it."): the command that asks for it, and the one the card's
// "Open the change" runs, a commit's own diff in the IDE's multi-file view.
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const SHA = /^[0-9a-f]{7,40}$/i;
// git's empty tree: what a first commit is compared with.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The rows `vscode.changes` shows for a commit: each changed file, before (its parent) and after. Pure, so it is tested without an
 * IDE. A file the commit added has no "before", and one it deleted no "after": that side is left out, as the IDE's own commit view does.
 */
function commitRows(api, uri, changes, parent, sha) {
  const rows = [];
  const seen = new Set();
  for (const c of changes || []) {
    const after = c.uri;
    if (!after || seen.has(after.fsPath)) continue;
    seen.add(after.fsPath);
    const added = c.added || c.status === 1;
    const deleted = c.deleted || c.status === 2;
    rows.push([after, added ? undefined : api.toGitUri(c.originalUri || after, parent), deleted ? undefined : api.toGitUri(after, sha)]);
  }
  return rows;
}

/** `git diff-tree --name-status -z` as changes: [{ added, deleted, path }]. A rename shows as its old file gone and its new one added. Pure. */
function parseNameStatus(out) {
  const t = String(out || "").split("\0");
  const list = [];
  for (let i = 0; i + 1 < t.length; i += 2) {
    const st = t[i].trim()[0];
    if (!st || !t[i + 1]) continue;
    if (st === "R" || st === "C") {
      if (!t[i + 2]) break;
      if (st === "R") list.push({ deleted: true, path: t[i + 1] });
      list.push({ added: true, path: t[i + 2] });
      i++;
    } else list.push({ added: st === "A", deleted: st === "D", path: t[i + 1] });
  }
  return list;
}

/** The files a commit changed, asked of git itself: the git extension's diffBetween compares with three dots, which a first commit (no parent) can't use. */
function rootCommitChanges(vscode, git, repoRoot, sha) {
  return new Promise((resolve) => {
    execFile(git || "git", ["diff-tree", "--root", "--no-commit-id", "--name-status", "--no-renames", "-r", "-z", sha], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(parseNameStatus(out).map((c) => ({ ...c, uri: vscode.Uri.file(path.join(repoRoot, c.path)) })));
    });
  });
}

/** A commit's diff in the IDE: the first repository that has it. A hash that isn't a commit here says so and opens nothing. */
async function openCommit(vscode, sha) {
  if (typeof sha !== "string" || !SHA.test(sha)) return false;
  const git = vscode.extensions.getExtension("vscode.git");
  if (!git) {
    vscode.window.showWarningMessage("Git isn't available in this window.");
    return false;
  }
  const api = (git.isActive ? git.exports : await git.activate()).getAPI(1);
  for (const repo of api.repositories) {
    let commit;
    try {
      commit = await repo.getCommit(sha);
    } catch {
      continue;
    }
    const root = !(commit.parents && commit.parents[0]);
    const parent = root ? EMPTY_TREE : commit.parents[0];
    const changes = root ? await rootCommitChanges(vscode, api.git && api.git.path, repo.rootUri.fsPath, commit.hash) : await repo.diffBetween(parent, commit.hash).catch(() => []);
    const rows = commitRows(api, null, changes, parent, commit.hash);
    if (!rows.length) {
      vscode.window.showInformationMessage(`${commit.hash.slice(0, 7)} changed no files.`);
      return true;
    }
    const subject = String(commit.message || "").split("\n")[0].slice(0, 60);
    await vscode.commands.executeCommand("vscode.changes", `${commit.hash.slice(0, 7)} · ${subject}`, rows);
    return true;
  }
  vscode.window.showInformationMessage(`${sha.slice(0, 7)} isn't a commit in this folder.`);
  return false;
}

/** The ask to Friday: what broke, in the person's words, or a command that failed (then it is the check). */
function bisectAsk(root, what, terminal) {
  const body = { kind: "bisect", path: "", from: 1, to: 1, text: "", root, problem: what || "", source: "the editor" };
  if (terminal) {
    body.source = `the terminal · ${terminal.cmd}`;
    body.problem = terminal.output || "";
    body.cwd = terminal.cwd || "";
  }
  return body;
}

/**
 * Commands that passed before (Arun, 2026-11-19, wave 2: a command that used to pass and fails now is offered "Find what broke"),
 * kept as hashes, not as typed (a line can hold a token), the last 60. Pure over its saved list, so it is tested without an IDE.
 */
function passedMemory(saved) {
  const hash = (line) => crypto.createHash("sha1").update(String(line)).digest("hex").slice(0, 16);
  const seen = new Set(Array.isArray(saved) ? saved.filter((x) => typeof x === "string") : []);
  return {
    remember(line) {
      // Everyday commands say nothing about the project's past.
      if (/^\s*(cd|ls|ll|pwd|clear|echo|cat|open|code|git (status|log|diff|branch))\b/.test(String(line))) return;
      const h = hash(line);
      seen.delete(h);
      seen.add(h);
      while (seen.size > 60) seen.delete(seen.values().next().value);
    },
    worked: (line) => seen.has(hash(line)),
    list: () => [...seen],
  };
}

function register(context, vscode, postAsk, firstRoot) {
  context.subscriptions.push(vscode.commands.registerCommand("friday.openCommit", (sha) => openCommit(vscode, sha)));
  context.subscriptions.push(
    vscode.commands.registerCommand("friday.findBreak", async () => {
      // A failed command's output is the problem when it comes from the terminal; here the person says what broke.
      const what = await vscode.window.showInputBox({
        title: "Find the commit that broke this",
        prompt: "What broke? Say what you saw, or the command that fails now.",
        placeHolder: "npm test fails in the checkout tests",
        ignoreFocusOut: true,
      });
      if (what === undefined) return;
      await postAsk(bisectAsk(firstRoot(), what.trim()));
    }),
  );
}

module.exports = { register, commitRows, parseNameStatus, passedMemory, openCommit, bisectAsk, EMPTY_TREE };
