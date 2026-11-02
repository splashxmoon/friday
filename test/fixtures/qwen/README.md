# Qwen Code ACP recording

`auth-required.json` was captured directly from `@qwen-code/qwen-code` **0.26.5**
on Windows using Node **22.23.3**, launched with `qwen --acp` on 2026-11-03.
The process used an empty temporary home and working directory, with credential
environment variables removed. No model request was made.

The recording contains both directions of the initialization and session creation
exchange. The temporary working-directory path was replaced with `/work/repo`;
the protocol payloads are otherwise unchanged. Replay remaps JSON-RPC IDs because
Friday allocates them across parser instances.

To reproduce, launch the same version in an empty home, send the recorded
`initialize` request followed by `session/new` using the temporary directory as
`cwd`, and record each JSON line sent and received. Close stdin after the session
creation response. Do not capture credentials or use a project containing secrets.

An authenticated coding turn was not run: no Qwen credentials were available in
the isolated environment. The remaining tests in `qwen-adapter.test.ts` are
explicitly synthetic contract exchanges covering successful turns and permissions.
