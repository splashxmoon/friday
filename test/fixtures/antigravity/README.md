# Antigravity CLI recordings

Three conversations with Antigravity CLI 1.5.2 (`agy acp`, macOS arm64, a personal Google AI account), driven by Friday's own
Antigravity adapter on 2026-11-06: every JSON-RPC frame both ways, in order, as `{ direction, frame }`.

- `manual-command.json`: Manual (`edits`), Gemini 3.8 Flash at a low thinking level. It asks before `echo FRIDAY_AGY_CMD`, the
  question is answered allow, it runs and answers.
- `failing-command.json`: Auto (`full`). `ls /no-such-dir-friday` fails: the call says `completed` with `exit_code: 1`.
- `plan.json`: Plan. Friday sets the thinking level, then the `mode` option to `plan`, before the instruction.

The only change from what was recorded: the scratch repository's path is `/work/repo`. Nothing in them is secret: no sign-in
passes over ACP. `test/antigravity-adapter.test.ts` plays them back.
