<p align="center">
  <img src="docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Your coding agents, side by side, on your own computer.</strong><br/>
  Run Claude Code, Codex, Cursor and a dozen more from one place. They split the work on a shared task board, message each other as they go, and you review it all before it ships.
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday?style=flat&label=%E2%98%85&color=08C" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Linux-4493F8?style=flat" alt="macOS and Linux" />
  <a href="https://github.com/splashxmoon/friday/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday/releases/latest/download/Friday-arm64.dmg"><b>Mac (Apple silicon)</b></a> ·
  <a href="https://github.com/splashxmoon/friday/releases/latest/download/Friday-x64.dmg"><b>Mac (Intel)</b></a> ·
  <a href="https://github.com/splashxmoon/friday/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>or, with Node.js 22: <code>npx github:splashxmoon/friday</code>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.png" />
    <img src="docs/assets/hero.png" alt="Friday with six agents at work at once: Claude Code and Codex, each on its own task in its own repository, listed in the sidebar and under Right now" width="960" />
  </picture>
</p>

Works with the subscriptions you already have. If a coding tool is installed and signed in on your computer, Friday can drive it:

<p>
  <kbd><img src="https://www.google.com/s2/favicons?domain=claude.ai&sz=64" width="14" valign="middle" alt="" /> Claude Code</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" width="14" valign="middle" alt="" /> Codex</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" width="14" valign="middle" alt="" /> Cursor</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" width="14" valign="middle" alt="" /> GitHub Copilot</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" width="14" valign="middle" alt="" /> OpenCode</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64" width="14" valign="middle" alt="" /> Gemini CLI</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" width="14" valign="middle" alt="" /> Devin</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=jetbrains.com&sz=64" width="14" valign="middle" alt="" /> Junie</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" width="14" valign="middle" alt="" /> Kiro</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=factory.ai&sz=64" width="14" valign="middle" alt="" /> Factory Droid</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" width="14" valign="middle" alt="" /> Grok Build</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" width="14" valign="middle" alt="" /> Cline</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=kilo.ai&sz=64" width="14" valign="middle" alt="" /> Kilo</kbd>
  <kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" width="14" valign="middle" alt="" /> Amp</kbd>
  <kbd>Any ACP agent</kbd>
</p>

## Your agents, working as a team

Friday doesn't just run your coding tools next to each other: it lets them work together. One agent can split a job into a **task board**; the others pick up the tasks that suit them, each in its own files, and every finished task is checked (its tests run, another agent reviews it) before it counts as done. Along the way they **message each other** directly: a heads-up about a rename, a question one of them waits on, an answer that comes back. You see every message as it happens.

<table>
<tr>
<td width="50%"><img src="docs/assets/task-board.png" alt="Claude Code's task board: one task done and checked, Gemini and Cursor on two more, the last waiting on them" /></td>
<td width="50%"><img src="docs/assets/agents-talk.png" alt="Codex telling Cursor about a rename, and Gemini asking Claude Code a question and getting an answer" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>A shared task board.</b> Claude Code split the work; Codex finished its part and Claude Code checked it; Gemini and Cursor are on theirs; the last task waits for all three.</sub></td>
<td width="50%" valign="top"><sub><b>Agents talking.</b> Codex tells Cursor what it renamed before Cursor trips over it; Gemini asks Claude Code how a 25-hour day should count, and goes on with the answer.</sub></td>
</tr>
</table>

## "So what's the catch?"

There isn't one. Friday on your own computer is free and MIT licensed. It has no account, no server of ours, and no model of its own: the work runs on your coding tools, on their own plans, and nothing comes back to us.

What we sell is [Friday Team](https://www.tryfridaywork.com), the hosted version, for when several people work in the same session: steering one agent together, reviewing each other's changes, and sharing what the agents did.

## Install

> [!IMPORTANT]
> Install and sign in to at least one coding tool first. Friday finds every one on your computer and can sign the rest in from its setup screen.
>
> - Claude Code: `claude auth login`
> - Codex: `codex login`
> - Cursor: `cursor-agent login`
> - GitHub Copilot: `copilot login`
> - OpenCode: `opencode auth login`
> - Gemini CLI: run `gemini` once and sign in

### The desktop app

| | |
| --- | --- |
| Mac, Apple silicon | [Friday-arm64.dmg](https://github.com/splashxmoon/friday/releases/latest/download/Friday-arm64.dmg) |
| Mac, Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday/releases/latest/download/Friday-x86_64.AppImage) (`chmod +x` it, then run it) |

Every version is on the [releases page](https://github.com/splashxmoon/friday/releases). The app is Friday in a window of its own, with the same server inside it, on `127.0.0.1` only.

> [!NOTE]
> Until the installers are signed, your computer will ask before opening one. On Windows, choose **More info**, then **Run anyway**. On a Mac, if it says Friday is damaged or can't be checked, move it to Applications and run `xattr -dr com.apple.quarantine /Applications/Friday.app` once.

### From a terminal

With Node.js 22 or newer and Git:

```bash
npx github:splashxmoon/friday
```

Friday opens in your browser at `http://127.0.0.1:4321`. To keep a copy:

```bash
git clone https://github.com/splashxmoon/friday
cd friday
npm install
npm start
```

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | `4321` | Where Friday listens, on this computer only. |
| `FRIDAY_HOME` | `~/.friday` | Where it keeps your sessions and settings. |
| `--no-open` | | Start without opening the browser. |

## Features

<table>
<tr>
<td width="50%" valign="middle">

### Every coding tool, one place

Friday finds the coding tools on your computer and whether each is signed in. Pick one per task, or let Auto choose by the job and by how much of each tool's usage is left.

</td>
<td width="50%"><img src="docs/assets/tools.png" alt="The coding tools Friday found on this computer, each signed in and ready" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### Never stuck on a usage limit

Each tool's remaining usage, always in view. When one runs out mid-task, the task moves to the agent best placed to finish it, with everything done so far, instead of starting over.

</td>
<td width="50%"><img src="docs/assets/usage.png" alt="Each coding tool's remaining usage, at a glance" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### Review before anything ships

Every run ends in a change set you read before you keep it. Leave notes on a line or a range and send them back to the agent; see which lines it wrote and which you did.

</td>
<td width="50%"><img src="docs/assets/notes.png" alt="A note on four changed lines, about to go back to the agent" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### Git, built in

Stage by file or by hunk, commit, pull, push, and open a pull request, stacked on another one if you are building in steps. Start any session on the branch you choose.

</td>
<td width="50%"><img src="docs/assets/git-panel.png" alt="The Git panel: staged files, changes by hunk, and a commit button" /></td>
</tr>
<tr>
<td width="50%" valign="middle">

### Pick the branch, or start a new one

Point a session at a folder, choose the branch it works on, or have it start a new branch from any other. Friday won't switch a folder with uncommitted work out from under you.

</td>
<td width="50%"><img src="docs/assets/branches.png" alt="Choosing which branch a new branch starts from" /></td>
</tr>
</table>

Also in the box: a live feed of every message, command and file change; approvals when a tool asks before running something; your dev server previewed beside the session; skills and saved commands shared across your tools; and sessions your tools come back to by themselves after a restart.

## Privacy

Friday listens on `127.0.0.1` only, so nothing else on your network can reach it, and it answers only its own page: a request from any other site, or from a page being previewed, is refused. What it keeps is one folder on your computer, readable only by you.

It sends nothing to us: no account, no analytics, no telemetry. It talks to GitHub for the pull requests, issues and skills you ask it about, and reads each coding tool's remaining usage from that tool's own provider, with the sign-in the tool already has.

## Developing

```bash
npm install
npm run typecheck
npm test
npm run build:css    # after changing styles
npm run desktop      # build the desktop app and open it
npm run desktop:dist # package installers for this computer into release/
```

Pushing a `v*` tag builds the installers for every platform on GitHub Actions and publishes them as a release ([release.yml](.github/workflows/release.yml)).

Issues and pull requests are welcome. For anything large, open an issue first so we can talk it through.

## License

[MIT](LICENSE)
