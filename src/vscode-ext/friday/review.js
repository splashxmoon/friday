"use strict";
// The agent's self-review in the IDE (Arun, 2026-11-19: "The agent reviews its own diff the way a senior engineer would (bugs,
// security, missing tests) and fixes what it finds before you see it"): each finding that names a file and a line is a read-only
// comment thread there, from one controller, "Friday self-review". The findings come from Friday (/api/vscode/review), posted by
// the page when the chat shows the review card.
const path = require("node:path");

const TAGS = { bug: "Bug", security: "Security", test: "Test", style: "Style", "for-you": "For you" };

/** The threads a review makes: a finding with no file is on the card only, a relative file is made whole from the folder. */
function reviewThreads(findings, folder) {
  const out = [];
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || !f.file || typeof f.file !== "string") continue;
    const file = path.isAbsolute(f.file) || /^[A-Za-z]:[\\/]/.test(f.file) ? f.file : path.join(folder || "", f.file);
    out.push({
      file,
      line: Math.max(1, Math.floor(Number(f.line)) || 1),
      label: `${TAGS[f.severity] || "Note"} · ${f.status === "fixed" ? "fixed" : "open"}`,
      title: String(f.title || ""),
      detail: String(f.detail || ""),
      fixed: f.status === "fixed",
    });
  }
  return out;
}

function watchReview(context, vscode) {
  const base = process.env.FRIDAY_URL;
  const token = process.env.FRIDAY_VSCODE_TOKEN;
  if (!base || !token) return;
  if (!vscode.comments || !vscode.comments.createCommentController || !vscode.CommentThreadCollapsibleState) return;
  const controller = vscode.comments.createCommentController("friday.selfReview", "Friday self-review");
  let threads = [];
  let seq = 0;
  const clear = () => {
    for (const t of threads) t.dispose();
    threads = [];
  };
  const show = (body) => {
    clear();
    for (const r of reviewThreads(body.findings, body.folder)) {
      let thread;
      try {
        const line = r.line - 1;
        const comment = {
          // Said once each (Arun, 2026-11-20: "not repeating of like self review"): the finding's title heads the thread, the author is
          // Friday, the label its kind and whether it was fixed, and the body only what it says.
          author: { name: "Friday" },
          label: r.label,
          mode: vscode.CommentMode ? vscode.CommentMode.Preview : 1,
          // Plain text: an agent's words are not drawn as Markdown, so no link or remote image comes out of them.
          body: r.detail || r.title,
        };
        thread = controller.createCommentThread(vscode.Uri.file(r.file), new vscode.Range(line, 0, line, 0), [comment]);
        thread.label = r.title || "Self-review";
        thread.canReply = false;
        thread.collapsibleState = r.fixed ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
        threads.push(thread);
      } catch {
        // A path the IDE can't read: that finding stays on the card.
      }
    }
  };
  let timer;
  const tick = async () => {
    clearTimeout(timer);
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/api/vscode/review`, { headers: { "x-friday-vscode": token } });
      if (res.ok) {
        const body = await res.json();
        if (body && typeof body.seq === "number" && body.seq !== seq) {
          seq = body.seq;
          show(body);
        }
      }
    } catch {
      // Friday not reachable: the threads stay as they were.
    }
    timer = setTimeout(tick, 4000);
  };
  void tick();
  context.subscriptions.push(controller, { dispose: () => (clearTimeout(timer), clear()) });
}

module.exports = { watchReview, reviewThreads };
