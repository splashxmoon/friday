"use strict";
// Review a teammate's pull request in the IDE (Arun, 2026-11-19, wave 3: "Review your teammates' pull requests in the IDE: their branch
// checked out on the side, the diff in the editor, comments where the lines are, and an agent's first pass"). The window is open on a
// copy Friday checked the pull request out in (src/runner/pr-ide.ts): its review threads are comment threads on their lines
// ("Pull request", from GitHub through the person's own gh), the person adds a comment on a line or a reply under one, the agent's
// first pass adds drafts they keep, edit or drop, and Submit review is the one button that posts: it asks first, because it speaks as
// them. Nothing is posted by anything else, and the words of a comment never go anywhere until then.
const fs = require("node:fs");
const path = require("node:path");

const CONTROLLER = "friday.prReview";

/** What a teammate wrote, drawn as Markdown without anything that loads from elsewhere: no image, and raw HTML stays text. */
function safeMarkdown(text) {
  // A reference-style image (`![alt][r]`, `![alt][]`, `![r]`) loads from its definition (`[r]: https://...`), which goes with it.
  const refs = new Set();
  const out = String(text || "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[image: ${alt}]` : "[image]"))
    .replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (_, alt, ref) => (refs.add((ref || alt).trim().toLowerCase()), alt ? `[image: ${alt}]` : "[image]"))
    .replace(/!\[([^\]]+)\](?![\[(:])/g, (_, ref) => (refs.add(ref.trim().toLowerCase()), `[image: ${ref}]`))
    .replace(/<img\b[^>]*>/gi, "[image]");
  return out.replace(/^ {0,3}\[([^\]]+)\]:[ \t]*\S.*$/gm, (line, ref) => (refs.has(ref.trim().toLowerCase()) ? "" : line));
}

/** How many lines a file has, for an outdated comment written on an older, longer version of it; 0 when it can't be read. */
function linesIn(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").length;
  } catch {
    return 0;
  }
}

/** The file's path in the pull request (forward slashes, from the copy's top), or null for a file outside the copy. */
function relPath(dir, file) {
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** The lines a selection covers (1-based): one line, or from the first to the last (a selection ending at a line's start stops before it). */
function lineSpan(range) {
  const start = range.start.line + 1;
  let end = range.end.line + 1;
  if (range.end.line > range.start.line && range.end.character === 0) end -= 1;
  return end > start ? { startLine: start, line: end } : { line: start };
}

/** What a review has in it to post: the kept comments and the replies (an agent's draft is not one until it is kept). */
function counts(items) {
  const n = { comments: 0, replies: 0, drafts: 0 };
  for (const i of items) {
    if (i.kind === "comment") n.comments++;
    else if (i.kind === "reply") n.replies++;
    else if (i.kind === "draft") n.drafts++;
  }
  return n;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

/** "2 comments, 1 reply" for the review's button and its question; "" when there is nothing yet. */
function summary(items) {
  const n = counts(items);
  return [n.comments ? plural(n.comments, "comment") : "", n.replies ? plural(n.replies, "reply", "replies") : ""].filter(Boolean).join(", ");
}

/** The body of the request Submit review makes: what the person kept and wrote, never a draft. */
function submission(event, body, items, rel = (i) => i) {
  return {
    event,
    body: body || "",
    comments: items.filter((i) => i.kind === "comment").map((i) => ({ path: rel(i.path), line: i.line, ...(i.startLine ? { startLine: i.startLine } : {}), body: i.body })),
    replies: items.filter((i) => i.kind === "reply").map((i) => ({ to: i.to, body: i.body })),
  };
}

/** Of what was sent, the replies the server says didn't go (each is the comment it answers and its words, used once): the rest went. */
function unsent(sent, failed) {
  const left = Array.isArray(failed) ? failed.map((f) => ({ to: Number(f && f.to), body: String((f && f.body) || "").trim() })) : [];
  return sent.filter((i) => {
    if (i.kind !== "reply") return false;
    const at = left.findIndex((f) => f.to === i.to && f.body === String(i.body).trim());
    if (at < 0) return false;
    left.splice(at, 1);
    return true;
  });
}

/** What is kept between windows: the person's words and the agent's drafts, not the threads (GitHub has those). */
function savable(items) {
  return items.map((i) => ({ kind: i.kind, path: i.path, line: i.line, ...(i.startLine ? { startLine: i.startLine } : {}), ...(i.to ? { to: i.to } : {}), body: i.body, ...(i.label ? { label: i.label } : {}) }));
}
function restorable(saved) {
  if (!Array.isArray(saved)) return [];
  return saved
    .filter((i) => i && ["comment", "reply", "draft"].includes(i.kind) && typeof i.body === "string" && i.body.trim() && typeof i.path === "string" && Number(i.line) > 0)
    .map((i) => ({ kind: i.kind, path: i.path, line: Math.floor(Number(i.line)), ...(Number(i.startLine) > 0 ? { startLine: Math.floor(Number(i.startLine)) } : {}), ...(Number(i.to) > 0 ? { to: Math.floor(Number(i.to)) } : {}), body: i.body, ...(typeof i.label === "string" ? { label: i.label } : {}) }));
}

function register(vscode, context, { roots }) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const here = () => (vscode.window && vscode.window.showInformationMessage ? vscode.window : null);
  // The commands are in the palette either way: outside a pull request's copy they say so.
  const notHere = () => here() && here().showInformationMessage("Open a pull request from Friday's Code Review first: Review in the IDE.");
  const needs = vscode.comments && vscode.comments.createCommentController && vscode.CommentThreadCollapsibleState && vscode.CommentMode;
  let ctx = null;
  let controller = null;
  /** The GitHub threads as read, each with its own VS Code thread. */
  let threads = [];
  let gh = [];
  /** The person's comments and replies, and the agent's drafts: {kind, path, line, startLine?, to?, body, label?, thread?, note?}. */
  let items = [];
  let files = [];
  /** What the agent found that isn't on a line of the change. */
  let loose = [];
  let me = "";
  /** The threads as last drawn, so a read that finds the same leaves the screen alone. */
  let drawn = "";
  /** The first pass or a refresh is running: a second one waits for it, not beside it. */
  let busy = false;
  let view = null;
  let bar = [];
  const changed = vscode.EventEmitter ? new vscode.EventEmitter() : null;
  if (changed) context.subscriptions.push(changed);
  const key = () => `friday.pr.${ctx.url}`;

  /** `ms`: how long to wait for the answer (the first pass takes minutes; Friday ends it at four, so its own words come back first). */
  async function call(op, extra, ms) {
    if (!base || !token) throw new Error("Friday is not connected to this editor. Reopen Code in Friday.");
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/pr`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-friday-vscode": token },
      body: JSON.stringify({ root: ctx ? ctx.dir : "", op, ...extra }),
      ...(ms && typeof AbortSignal !== "undefined" && AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : {}),
    }).catch((e) => {
      throw new Error(e && e.name === "TimeoutError" ? "Friday took too long to answer. Try again." : e && e.message === "fetch failed" ? "Couldn't reach Friday. Is it still open?" : (e && e.message) || String(e));
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `Friday answered ${res.status}`);
    return body;
  }

  const uriOf = (p) => vscode.Uri.file(path.join(ctx.dir, ...String(p).split("/")));
  const rangeOf = (line, startLine) => new vscode.Range((startLine || line) - 1, 0, line - 1, 0);
  const save = () => {
    if (ctx && context.workspaceState) context.workspaceState.update(key(), savable(items));
    if (changed) changed.fire();
    refreshBar();
  };

  /** One comment as the IDE draws it. `parent` is its thread, which the edit commands need. */
  function note(spec) {
    const n = {
      author: { name: spec.author },
      body: spec.markdown ? Object.assign(new vscode.MarkdownString(safeMarkdown(spec.body)), { isTrusted: false, supportHtml: false }) : spec.body,
      mode: vscode.CommentMode.Preview,
      contextValue: spec.context,
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.at ? { timestamp: new Date(spec.at) } : {}),
    };
    return n;
  }
  const mineNote = (i) =>
    note({
      author: i.kind === "draft" ? "Friday's agent" : me || "You",
      body: i.body,
      context: i.kind === "draft" ? "friday.draft" : "friday.pending",
      label: i.kind === "draft" ? i.label || "Draft · not posted" : i.kind === "reply" ? "Pending reply · posts when you submit the review" : "Pending · posts when you submit the review",
    });

  /**
   * One of the person's comments, replies or the agent's drafts put on screen: a reply under its GitHub thread, anything else as a
   * thread of its own at its line. Done one at a time (not by drawing everything again): a thread the person is typing in is never
   * thrown away under them, which the IDE answers with errors in its console.
   */
  function place(i) {
    i.note = mineNote(i);
    const host = i.kind === "reply" ? gh.find((g) => g.first === i.to && g.vt) : null;
    // A file the copy doesn't have (the pull request deletes it) has no editor to draw in: it stays in the view and is posted all the same.
    if (!host && !fs.existsSync(uriOf(i.path).fsPath)) {
      i.thread = null;
      i.note = null;
      return;
    }
    if (host) {
      host.vt.comments = [...host.vt.comments, i.note];
      i.thread = null;
      i.note.parent = host.vt;
      return;
    }
    // A reply whose thread is gone (resolved away on GitHub, or deleted) stands as its own thread at its line.
    i.thread = controller.createCommentThread(uriOf(i.path), rangeOf(i.line, i.startLine), [i.note]);
    i.thread.canReply = false;
    i.thread.label = i.kind === "draft" ? "Agent's draft" : "Your comment";
    i.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    i.note.parent = i.thread;
  }
  function unplace(i) {
    if (i.thread) i.thread.dispose();
    else if (i.note && i.note.parent) i.note.parent.comments = i.note.parent.comments.filter((c) => c !== i.note);
    i.thread = null;
    i.note = null;
  }

  /**
   * The threads drawn from what is known: GitHub's, then the person's and the agent's. A thread that is the same as the one on screen
   * is left alone (a reply being typed in it stays), one that changed or is new is drawn, one that is gone is taken down.
   */
  function draw() {
    if (!controller) return;
    const had = new Map(gh.map((g) => [g.t.id, g]));
    const next = [];
    for (const t of threads) {
      const sig = JSON.stringify(t);
      const old = had.get(t.id);
      if (old && old.sig === sig) {
        next.push(old);
        had.delete(t.id);
        continue;
      }
      const first = t.comments[0];
      const file = uriOf(t.path);
      // Its file is not in the copy (deleted or renamed by the pull request): listed in the view, with GitHub to read it on.
      const gone = !fs.existsSync(file.fsPath);
      // An outdated thread keeps the line an older commit had: held inside the file as it is now.
      const total = t.outdated && !gone ? linesIn(file.fsPath) : 0;
      const line = total && t.line > total ? total : t.line;
      const startLine = t.startLine && t.startLine < line ? t.startLine : undefined;
      let vt = null;
      if (!gone) {
        vt = controller.createCommentThread(file, rangeOf(line, startLine), t.comments.map((c) => note({ author: c.author, body: c.body, markdown: true, context: "friday.github", at: c.at })));
        vt.canReply = true;
        vt.contextValue = "friday.prThread";
        vt.label = [t.resolved ? "Resolved" : "", t.outdated ? "Outdated" : "", t.removed ? "On a removed line" : "", t.file ? "On the file" : "", t.more ? "More on GitHub" : ""].filter(Boolean).join(" · ") || "Review";
        // Drawn folded and opened a moment later: opened while the diff's editors are still being built, the IDE logs errors for them.
        vt.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        if (!(t.resolved || t.outdated)) setTimeout(() => { try { if (gh.some((g) => g.vt === vt)) vt.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded; } catch {} }, 3000);
        if (vscode.CommentThreadState) vt.state = t.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      }
      next.push({ t, vt, sig, gone, first: first ? first.id : 0 });
    }
    for (const g of had.values()) g.vt && g.vt.dispose();
    gh = next;
    // What was drawn under a thread that is new now (a reply in it, or in one that went) is drawn again.
    const live = new Set(gh.map((g) => g.vt).filter(Boolean));
    for (const i of items) {
      if (!i.note || (!i.thread && !live.has(i.note.parent))) {
        i.thread = null;
        place(i);
      }
    }
    refreshBar();
    if (changed) changed.fire();
  }

  const itemOf = (n) => items.find((i) => i.note === n);
  const sync = (i) => {
    if (i.thread) i.thread.comments = [i.note];
    else if (i.note && i.note.parent) i.note.parent.comments = [...i.note.parent.comments];
  };

  async function load(quiet) {
    if (busy && quiet !== "force") return here() && !quiet ? here().showInformationMessage("Friday is already reading the pull request.") : undefined;
    busy = true;
    try {
      const got = await call("threads");
      const same = drawn !== "" && drawn === JSON.stringify(got.threads || []);
      threads = got.threads || [];
      files = got.files || [];
      me = got.me || me;
      // Nothing new on GitHub: what is on screen stays, with whatever is being typed in it.
      if (same) return void (changed && changed.fire());
      drawn = JSON.stringify(threads);
      draw();
    } catch (e) {
      if (!quiet && here()) here().showWarningMessage(`Couldn't read the review comments: ${e.message || e}`);
    } finally {
      busy = false;
    }
  }

  // ── what the person does ──────────────────────────────────────────────────────────────────────────────────────────────

  /** A comment typed in a thread's box: under somebody's comment it is a reply, on a line without one it is a new comment. Neither is posted yet. */
  async function reply(r) {
    if (!ctx || !r || !r.thread || !String(r.text || "").trim()) return;
    const text = String(r.text).trim();
    const known = gh.find((g) => g.vt === r.thread);
    if (known) {
      const i = { kind: "reply", path: known.t.path, line: known.t.line, to: known.first, body: text };
      items.push(i);
      place(i);
      return save();
    } else {
      const rel = relPath(ctx.dir, r.thread.uri.fsPath);
      if (!rel) {
        r.thread.dispose();
        return here() && here().showWarningMessage("Comments go on the pull request's own files, in the copy Friday checked out.");
      }
      const span = lineSpan(r.thread.range);
      items.push({ kind: "comment", path: rel, line: span.line, ...(span.startLine ? { startLine: span.startLine } : {}), body: text });
      // The box the person typed in becomes this comment's thread.
      const i = items[items.length - 1];
      i.thread = r.thread;
      i.note = mineNote(i);
      i.note.parent = r.thread;
      r.thread.comments = [i.note];
      r.thread.canReply = false;
      r.thread.label = "Your comment";
      save();
    }
  }

  const note$ = (n) => (n && typeof n === "object" ? itemOf(n) : null);
  cmd("friday.pr.keepDraft", (n) => {
    const i = note$(n);
    if (!i || i.kind !== "draft") return;
    i.kind = "comment";
    i.note = mineNote(i);
    if (i.thread) (i.note.parent = i.thread), (i.thread.comments = [i.note]), (i.thread.label = "Your comment");
    save();
  });
  const drop = (i) => {
    items = items.filter((x) => x !== i);
    unplace(i);
    save();
  };
  // Edit asks in a box over the editor with the words in it, rather than editing in the thread's own box: the same on every IDE.
  cmd("friday.pr.editNote", async (n) => {
    const i = note$(n);
    if (!i) return;
    const text = await vscode.window.showInputBox({ title: i.kind === "draft" ? "Edit the agent's draft" : "Edit your comment", value: i.body, ignoreFocusOut: true, prompt: `${i.path}:${i.line}. Posted only when you submit the review.` });
    if (text === undefined) return;
    if (!text.trim()) return drop(i);
    i.body = text.trim();
    i.note.body = i.body;
    sync(i);
    save();
  });
  cmd("friday.pr.dropNote", (n) => {
    const i = note$(n);
    if (i) drop(i);
  });
  cmd("friday.pr.reply", (r) => void reply(r));

  /** The agent's first pass: its findings arrive as drafts on their lines, marked as drafts, for the person to keep, edit or drop. */
  async function firstPass() {
    if (!ctx) return notHere();
    if (busy) return here() && here().showInformationMessage("The agent is already reading the pull request.");
    busy = true;
    try {
      await firstPassRun();
    } finally {
      busy = false;
    }
  }
  async function firstPassRun() {
    const run = () => call("firstpass", undefined, 290000);
    const got = vscode.window.withProgress
      ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "The agent is reading the pull request (it changes nothing)…" }, () => run().catch((e) => ({ error: e.message || String(e) })))
      : await run().catch((e) => ({ error: e.message || String(e) }));
    if (got.error) return here() && here().showWarningMessage(got.error);
    // An earlier pass's drafts that were not kept are replaced by this one's.
    for (const old of items.filter((i) => i.kind === "draft")) unplace(old);
    items = items.filter((i) => i.kind !== "draft");
    for (const d of got.drafts || []) {
      const i = { kind: "draft", path: d.path, line: d.line, body: d.body, label: `Draft · ${{ high: "Bug", medium: "Likely a problem", low: "Worth knowing" }[d.severity] || "Note"} · not posted` };
      items.push(i);
      place(i);
    }
    loose = got.loose || [];
    save();
    const n = (got.drafts || []).length;
    const extra = loose.length ? ` ${plural(loose.length, "more finding")} aren't on a line of the change: they're listed in the Pull request view.` : "";
    if (here()) here().showInformationMessage(n ? `${plural(n, "draft comment")} from the agent, on their lines. Keep, edit or drop each; nothing is posted until you submit.${extra}` : `The agent found nothing to comment on.${extra}`);
    if (n && items.find((i) => i.kind === "draft")) {
      const first = items.find((i) => i.kind === "draft");
      void openAt(first.path, first.line);
    }
  }

  /** Submit review: the verdict, the words, and one more question before anything is posted, because it speaks as the person. */
  async function submit() {
    if (!ctx) return notHere();
    const w = vscode.window;
    const mine = items.filter((i) => i.kind !== "draft");
    const drafts = items.filter((i) => i.kind === "draft").length;
    const has = summary(mine);
    const pick = await w.showQuickPick(
      [
        { label: "$(check) Approve", description: "It can merge", event: "APPROVE" },
        { label: "$(request-changes) Request changes", description: "It needs something first", event: "REQUEST_CHANGES" },
        { label: "$(comment) Comment", description: "Say something without a verdict", event: "COMMENT" },
      ],
      { title: `Submit review of #${ctx.number} ${ctx.title}`.slice(0, 90), placeHolder: has ? `${has} will be posted with it` : "Nothing written yet: the verdict alone, or add comments on lines first", ignoreFocusOut: true },
    );
    if (!pick) return;
    const body = await w.showInputBox({
      title: `${pick.label.replace(/\$\([^)]*\)\s*/, "")} · #${ctx.number}`,
      prompt: pick.event === "REQUEST_CHANGES" && !mine.some((i) => i.kind === "comment") ? "Say what should change (required)" : "Your words on the whole pull request (optional)",
      ignoreFocusOut: true,
      validateInput: (v) => (pick.event === "REQUEST_CHANGES" && !v.trim() && !mine.some((i) => i.kind === "comment") ? "A request for changes says what." : pick.event === "COMMENT" && !v.trim() && !mine.length ? "There is nothing to post yet." : undefined),
    });
    if (body === undefined) return;
    const who = me || "you";
    const verdict = pick.event === "APPROVE" ? "approve" : pick.event === "REQUEST_CHANGES" ? "request changes on" : "comment on";
    const sure = await w.showWarningMessage(
      `Post this review on GitHub as ${who}?`,
      { modal: true, detail: `You ${verdict} #${ctx.number} ${ctx.title}${has ? `, with ${has}` : ""}.${drafts ? `\n${plural(drafts, "draft")} from the agent ${drafts === 1 ? "is" : "are"} not included: keep one to include it.` : ""}\nIt is posted as you, through your own GitHub sign-in, and can't be taken back from here.` },
      "Post review",
    );
    if (sure !== "Post review") return;
    try {
      const sent = mine.slice();
      const done = await call("submit", submission(pick.event, body, sent));
      // What went is cleared. A reply that didn't go (the review is up by then) stays to send again: sending the review again
      // would post it twice.
      const stay = unsent(sent, done.failed);
      for (const i of sent) if (!stay.includes(i)) unplace(i);
      items = items.filter((i) => !sent.includes(i) || stay.includes(i));
      save();
      await load(true);
      const text = `${done.note}${done.moved ? ` ${plural(done.moved, "comment")} weren't on a line of the change, so they're in the review's own words.` : ""}`;
      const open = await (stay.length ? w.showWarningMessage(text, "Open on GitHub") : w.showInformationMessage(text, "Open on GitHub"));
      if (open && vscode.env && vscode.env.openExternal) vscode.env.openExternal(vscode.Uri.parse(ctx.url));
    } catch (e) {
      // What went before the failure stays: the person's words are still here to send again.
      w.showErrorMessage(`The review wasn't posted: ${e.message || e}`);
    }
  }

  // ── looking around ────────────────────────────────────────────────────────────────────────────────────────────────────────

  async function openAt(rel, line) {
    try {
      // The file is already the one in front: move to the line in it. Opening it again right after threads were drawn on it made the
      // IDE build its editor twice and log an error.
      const ed = vscode.window.activeTextEditor;
      if (ed && ed.document.uri.fsPath === uriOf(rel).fsPath && vscode.Selection && vscode.TextEditorRevealType) {
        const at = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
        ed.selection = new vscode.Selection(at, at);
        ed.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        // From a click in the view the editor takes the keys, as it does when the file is opened.
        if (vscode.commands.executeCommand) await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uriOf(rel));
      const p = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(p, p), preview: false });
    } catch {
      // A file the pull request deletes isn't in the copy: nothing to open.
    }
  }

  /** One file as a two-sided diff against where the branch came from, which is where its comments are drawn (on the new side). */
  async function openDiff(rel) {
    try {
      const git = vscode.extensions.getExtension("vscode.git");
      const api = git ? (git.isActive ? git.exports : await git.activate()).getAPI(1) : null;
      const repo = api && (api.repositories.find((r) => path.resolve(r.rootUri.fsPath) === path.resolve(ctx.dir)) || (await api.openRepository(vscode.Uri.file(ctx.dir))));
      const mb = repo ? await repo.getMergeBase(`origin/${ctx.base}`, "HEAD") : "";
      if (!mb) return openAt(rel, 1);
      await vscode.commands.executeCommand("vscode.diff", api.toGitUri(uriOf(rel), mb), uriOf(rel), `${rel} · PR #${ctx.number}`);
    } catch {
      await openAt(rel, 1);
    }
  }
  cmd("friday.pr.openFile", (rel) => (typeof rel === "string" ? openDiff(rel) : undefined));
  cmd("friday.pr.reveal", (rel, line) => (typeof rel === "string" ? openAt(rel, Number(line) || 1) : undefined));
  cmd("friday.pr.loose", (f) => f && here() && here().showInformationMessage(`${f.title}${f.detail ? `\n\n${f.detail}` : ""}${f.path ? `\n\n${f.path}${f.line ? `:${f.line}` : ""}` : ""}`, { modal: true }));
  cmd("friday.pr.firstPass", () => void firstPass());
  cmd("friday.pr.submit", () => void submit());
  cmd("friday.pr.refresh", () => (ctx ? load(false) : notHere()));
  // Its address is the pull request's, or a comment's (a thread whose file is gone, or with more comments than were read).
  cmd("friday.pr.openOnGitHub", (url) => (ctx && vscode.env && vscode.env.openExternal ? vscode.env.openExternal(vscode.Uri.parse(typeof url === "string" && /^https:\/\/github\.com\//.test(url) ? url : ctx.url)) : notHere()));

  // ── the Pull request view and the bar ───────────────────────────────────────────────────────────────────────────────────

  const TI = vscode.TreeItem;
  const icon = (n) => (vscode.ThemeIcon ? new vscode.ThemeIcon(n) : undefined);
  const provider = {
    onDidChangeTreeData: changed ? changed.event : undefined,
    getChildren(node) {
      if (!ctx) return [];
      if (!node) {
        const n = counts(items);
        return [
          { kind: "head" },
          { kind: "action", id: "first", label: "Agent's first pass", desc: "Drafts, not posted", icon: "sparkle", command: "friday.pr.firstPass" },
          { kind: "action", id: "submit", label: "Submit review…", desc: summary(items.filter((i) => i.kind !== "draft")) || "Approve, request changes or comment", icon: "check-all", command: "friday.pr.submit" },
          ...(n.drafts || loose.length ? [{ kind: "group", id: "drafts", label: "Agent's draft", count: n.drafts + loose.length }] : []),
          ...(n.comments + n.replies ? [{ kind: "group", id: "mine", label: "Your comments", count: n.comments + n.replies }] : []),
          { kind: "group", id: "threads", label: "Comments on GitHub", count: threads.length },
          { kind: "group", id: "files", label: "Files changed", count: files.length },
        ];
      }
      if (node.kind !== "group") return [];
      if (node.id === "drafts") return [...items.filter((i) => i.kind === "draft").map((i) => ({ kind: "item", i })), ...loose.map((f) => ({ kind: "loose", f }))];
      if (node.id === "mine") return items.filter((i) => i.kind === "comment" || i.kind === "reply").map((i) => ({ kind: "item", i }));
      if (node.id === "threads") return threads.map((t) => ({ kind: "thread", t }));
      return files.map((f) => ({ kind: "file", f }));
    },
    getTreeItem(node) {
      const open = vscode.TreeItemCollapsibleState;
      if (node.kind === "head") {
        const item = new TI(`#${ctx.number} ${ctx.title}`, open.None);
        item.description = [ctx.author && `by ${ctx.author}`, `${ctx.head || "branch"} → ${ctx.base || "base"}`].filter(Boolean).join(" · ");
        item.tooltip = `${ctx.owner}/${ctx.repo} #${ctx.number}\n${ctx.title}\n${ctx.author ? `by ${ctx.author}\n` : ""}${ctx.head} into ${ctx.base}\nChecked out in a copy beside your own folder.`;
        item.iconPath = icon("git-pull-request");
        item.command = { command: "friday.pr.openOnGitHub", title: "Open on GitHub" };
        return item;
      }
      if (node.kind === "action") {
        const item = new TI(node.label, open.None);
        item.id = `pr-${node.id}`;
        item.description = node.desc;
        item.iconPath = icon(node.icon);
        item.command = { command: node.command, title: node.label };
        return item;
      }
      if (node.kind === "group") {
        const item = new TI(node.label, node.count ? (node.id === "files" ? open.Collapsed : open.Expanded) : open.None);
        item.id = `pr-g-${node.id}`;
        item.description = String(node.count);
        return item;
      }
      if (node.kind === "item") {
        const i = node.i;
        const item = new TI(`${i.path}:${i.line}`, open.None);
        item.description = `${i.kind === "draft" ? "draft · " : i.kind === "reply" ? "reply · " : ""}${i.body.split("\n")[0].slice(0, 60)}`;
        item.tooltip = i.body;
        item.iconPath = icon(i.kind === "draft" ? "comment-draft" : "comment");
        item.command = { command: "friday.pr.reveal", title: "Show", arguments: [i.path, i.line] };
        return item;
      }
      if (node.kind === "loose") {
        const item = new TI(node.f.title, open.None);
        item.description = node.f.path ? `${node.f.path}${node.f.line ? `:${node.f.line}` : ""}` : "not on a line";
        item.tooltip = node.f.detail;
        item.iconPath = icon("info");
        item.command = { command: "friday.pr.loose", title: "Read", arguments: [node.f] };
        return item;
      }
      if (node.kind === "thread") {
        const t = node.t;
        const gone = !!(gh.find((g) => g.t === t) || {}).gone;
        const item = new TI(gone ? t.path : `${t.path}:${t.line}`, open.None);
        const first = t.comments[0];
        item.description = `${gone ? "file removed · " : ""}${first ? first.author : ""}${t.comments.length > 1 ? ` +${t.comments.length - 1}` : ""}${t.resolved ? " · resolved" : t.outdated ? " · outdated" : ""}${t.more ? " · more on GitHub" : ""}`;
        item.tooltip = first ? first.body.slice(0, 400) : "";
        item.iconPath = icon(gone ? "trash" : t.resolved ? "pass" : "comment-discussion");
        // A file the pull request removes has no line to go to: the comment is read on GitHub.
        item.command = gone || t.more ? { command: "friday.pr.openOnGitHub", title: "Open on GitHub", arguments: [(first && first.url) || ctx.url] } : { command: "friday.pr.reveal", title: "Show", arguments: [t.path, t.line] };
        return item;
      }
      const item = new TI(node.f, open.None);
      item.iconPath = icon("file");
      item.command = { command: "friday.pr.openFile", title: "Open its diff", arguments: [node.f] };
      return item;
    },
  };

  function refreshBar() {
    if (!bar.length) return;
    const mine = summary(items.filter((i) => i.kind !== "draft"));
    bar[0].text = `$(check-all) Submit review${mine ? ` · ${mine}` : ""}`;
    bar[0].tooltip = "Approve, request changes or comment on this pull request: asks before posting";
    if (view) view.message = counts(items).drafts ? `${plural(counts(items).drafts, "draft")} from the agent: keep, edit or drop each.` : undefined;
  }

  /** The window is open on a pull request's copy: its comments, its view and its bar. */
  async function open(next) {
    const same = ctx && ctx.url === next.url && ctx.dir === next.dir;
    ctx = next;
    me = next.me || me;
    if (same) return;
    if (vscode.commands.executeCommand) void vscode.commands.executeCommand("setContext", "friday.prReview", true);
    if (needs && !controller) {
      controller = vscode.comments.createCommentController(CONTROLLER, "Pull request");
      context.subscriptions.push(controller);
      controller.options = { placeHolder: "Comment on this line (posted when you submit the review)…", prompt: "Add to review" };
      // Any line of a file of the copy takes a comment (the new side of the change).
      controller.commentingRangeProvider = { provideCommentingRanges: (doc) => (ctx && doc.uri.scheme === "file" && relPath(ctx.dir, doc.uri.fsPath) ? [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)] : []) };
    }
    if (vscode.window.createTreeView && changed && !view) {
      view = vscode.window.createTreeView("friday.pullRequest", { treeDataProvider: provider, showCollapseAll: false });
      context.subscriptions.push(view);
    }
    if (view) view.title = `Pull request #${ctx.number}`;
    if (vscode.window.createStatusBarItem && !bar.length) {
      const b = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      b.command = "friday.pr.submit";
      b.show();
      context.subscriptions.push(b);
      bar = [b];
    }
    items = restorable(context.workspaceState ? context.workspaceState.get(key(), []) : []);
    // Drawn now, not once GitHub has answered: what was kept is on its lines even when this window is offline.
    draw();
    await load(true);
    // The review is why this window is open: the Friday side bar shows it, with the pull request at the top.
    try {
      await vscode.commands.executeCommand("workbench.view.extension.friday");
    } catch {
      // The side bar stays as it was.
    }
  }

  /** Whether a folder this window has open is a pull request's copy (the server says, from the copy's own git folder). */
  async function check() {
    if (!base || !token) return;
    for (const root of roots()) {
      try {
        const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/pr`, { method: "POST", headers: { "content-type": "application/json", "x-friday-vscode": token }, body: JSON.stringify({ root, op: "context" }) });
        const body = await res.json().catch(() => ({}));
        if (body && body.context) return void (await open(body.context));
      } catch {
        // Friday not reachable: looked at again later.
      }
    }
  }
  if (base && token) {
    const first = setTimeout(() => void check(), 1500);
    if (first.unref) first.unref();
    // Friday not ready yet at the first look: asked again a few times, then left (a copy opened under this window later asks through
    // reviewChanges, and a folder added to it asks below). A window that isn't on a pull request does not keep asking.
    let tries = 0;
    const timer = setInterval(() => {
      if (ctx || ++tries > 5) return clearInterval(timer);
      void check();
    }, 12000);
    if (timer.unref) timer.unref();
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
    if (vscode.workspace && vscode.workspace.onDidChangeWorkspaceFolders) context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void (ctx || check())));
  }
  return { check };
}

module.exports = { register, safeMarkdown, relPath, lineSpan, counts, summary, submission, unsent, linesIn, savable, restorable };
