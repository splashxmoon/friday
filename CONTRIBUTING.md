# Contributing to Friday

Thanks for helping. Bug fixes, support for another coding tool, better docs and new features are all welcome.

## Getting set up

You need Node.js 22 or newer and Git. No database or other service: the tests run on the same in-memory store Friday uses.

```bash
git clone https://github.com/splashxmoon/friday
cd friday
npm install
npm start            # Friday in your browser, from this folder
npm run desktop      # or as the desktop app
```

Before you open a pull request:

```bash
npm run typecheck
npm test
```

CI runs both on macOS, Windows and Linux for every pull request.

## Where things live

- `src/runner/adapters.ts`: one adapter per coding tool (how it is started, signed in, and how its output is read). `ADAPTERS` at the bottom lists them.
- `src/types.ts`: `EngineTool` (the tool names) and `TOOL_INFO` (name, install line, docs link, colour).
- `src/client/`: the app's screens. `BrandMarks.tsx` has each tool's mark.
- `test/`: one `*.test.ts` per area, run with Node's test runner through `scripts/test.mjs`.

## Running tests

`npm test` runs every file and takes several minutes. To run one or two:

```bash
npm test -- test/acp.test.ts
```

## Adding a coding tool

If the tool speaks the Agent Client Protocol (ACP), its adapter is a short `acp({...})` call: see `kilo`, `opencode` or `grok` in `src/runner/adapters.ts`. Add its name to `EngineTool` and an entry to `TOOL_INFO` in `src/types.ts`, then run `npm run typecheck`: it lists every other place that needs an entry. Add a test next to `test/acp.test.ts` that feeds the adapter a few of the tool's own lines.

## Good first issues

Look for the [good first issue](https://github.com/splashxmoon/friday/labels/good%20first%20issue) label. Say in the issue that you are taking one, so two people don't do the same work.

## Pull requests

- Keep each one to one change, with a test when it changes behaviour.
- Describe what it changes for someone using Friday, and how you checked it.
- Don't edit `package-lock.json` by hand. If you need a new dependency, say so in the pull request and we'll add it.

## What happens after a merge

This repository is published from the source Friday Team is built from too. When we merge your pull request, we bring it into that source, and the next update here carries it on. Your commit stays in this repository's history under your name. Once in a while a change lands a little differently, to fit code that only the hosted version has. We'll say so in the pull request when it does.

## Reporting a security problem

Please don't put the details in a public issue. [SECURITY.md](SECURITY.md) says where to send it.
