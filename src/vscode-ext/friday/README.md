# Friday for VS Code

Bundled with Friday (not downloaded) and installed into Friday's own VS Code by the runner.

- Color themes: Friday Dark, Friday Light (follow Friday's light/dark setting).
- Friday: Ask an agent about this (Cmd/Ctrl+L): sends the selection, or the current line, to Friday's agent panel.
- Cmd/Ctrl+E (Agents or Code) and Cmd/Ctrl+Alt+B (agent column) are forwarded to Friday, as the frame keeps them from the page.
- Opens the files Friday asks for (`$FRIDAY_VSCODE_BRIDGE/open.json`).

Environment (set by Friday): `FRIDAY_URL`, `FRIDAY_VSCODE_TOKEN`, `FRIDAY_VSCODE_BRIDGE`.
Plain CommonJS, no build step, no dependencies.

Keep / Undo on what an agent writes (marks.js, diff.js, edits.js):
- Cmd/Ctrl+K with code selected: say what to change; an agent edits only those lines, and the change shows in place with Keep / Undo. With nothing selected, Cmd/Ctrl+K stays VS Code's own chord key. With a selection it is Friday's: the chords that start with it and need a selection (Cmd+K Cmd+C comment, Cmd+K Cmd+F format selection) are reached from the command palette or the right-click menu instead.
- While a task of Code's runs, each file it changes shows its blocks against git HEAD (or the text just before the change) with Keep / Undo, "is editing" in the status bar, and Keep all / Undo all / Compare in the editor title. Cmd/Ctrl+Enter keeps and Cmd/Ctrl+Backspace undoes the block, only with the cursor on its first line (where the lens is); anywhere else in the block they stay the editor's own. Undoing a block you have typed in asks first.
- `friday.followAgent` (off by default): open each file the agent edits beside the editor, without taking focus.
- A file with unsaved typing is never saved over; Undo there changes the buffer only.

Review a teammate's pull request (pr-review.js; Code Review's and Needs you's "Review in the IDE"):
- Friday checks the pull request's head out in a copy of its own (never over your checkout) and opens it as this window's folder, with the diff of the whole pull request. The side bar's Pull request view lists its description, the review comments on GitHub, your comments and the files.
- GitHub's review threads are comment threads on their lines ("Pull request"), read through your own `gh`. A comment on a line, or a reply under a thread, is kept in the IDE until you submit: nothing is posted by writing it.
- Agent's first pass: your coding tool, in plan mode in the copy, reads the change and returns draft comments on lines, marked "Draft · not posted". Keep, edit or drop each; only kept ones are posted.
- Submit review (the status bar, the view, the palette): Approve, Request changes or Comment, your words, then one question that says it posts as you. It is the one button that does; it posts through `gh` with the JSON on stdin.

Stacked pull requests (stack-view.js; the plan and the git steps are src/stack-plan.ts and src/runner/stack-pr.ts):
- The Stack view in Friday's side bar lists each stack the folder has, its parts bottom first, with the pull request's number, its checks, and how far each part is behind the one below. Restack rebases every part onto the one below it (in a temporary worktree, never in the open folder), pushes with a lease and points each pull request at its new base. A part that merged drops out. On a conflict it stops, changes nothing on that part and offers to hand it to the agent.
- Friday asks `/api/vscode/stack` (the IDE's token): GET `?root=` for the standing, POST `{root, id?}` to restack.

