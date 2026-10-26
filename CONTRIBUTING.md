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

## Pull requests

- Keep each one to one change, with a test when it changes behaviour.
- Describe what it changes for someone using Friday, and how you checked it.
- Don't edit `package-lock.json` by hand. If you need a new dependency, say so in the pull request and we'll add it.

## What happens after a merge

This repository is published from the source Friday Team is built from too. When we merge your pull request, we bring it into that source, and the next update here carries it on. Your commit stays in this repository's history under your name. Once in a while a change lands a little differently, to fit code that only the hosted version has. We'll say so in the pull request when it does.

## Reporting a security problem

Please don't put the details in a public issue. Open one that says only that you have a security report, and we'll give you a private way to send it.
