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

## Authenticated validation

`success.json` was recorded from Qwen Code 0.26.5 on Windows with Node 24.22.2
using Friday's actual adapter and OpenRouter's `openrouter/free` route. It includes
the initialization, session creation, prompt, text chunks, and completion response.
Unrelated session notifications (commands, thoughts, plans, and status metadata)
were omitted to keep the fixture focused. The working directory and session ID
were replaced with `/work/repo` and `qwen-session-1` respectively. No credentials
are present; the provider key was held only by an ephemeral local gateway.

Live checks also exercised reading and editing a temporary `add.mjs`, fixing
subtraction to addition, asking Friday for shell permission, and running
`node --test add.test.mjs` successfully. A separate conversation was reloaded
through `session/load` and correctly repeated its previous answer. The first
coding conversation's follow-up hit the gateway's local request cap; the separate
short resumption check completed successfully.

The gateway rejected paid model selections and forwarded only `openrouter/free`
with zero-price provider constraints and no paid plugins. OpenRouter reported
zero credit usage after validation. The temporary encrypted key was deleted.
Other protocol tests are explicitly synthetic contract exchanges.
