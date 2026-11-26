<p align="center">
  <img src="docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>One app for all your coding agents.</strong><br/>
  Claude Code, Codex, Cursor and 15 more, on the subscriptions you already pay for. Run them side by side, or hand them a job: they split it, review each other's work, and pick up when one runs out. Free and open source, on your own computer.
</p>

<p align="center"><sub><b>English</b> · <a href="docs/readme/README.zh-CN.md">简体中文</a> · <a href="docs/readme/README.zh-TW.md">繁體中文</a> · <a href="docs/readme/README.ja.md">日本語</a> · <a href="docs/readme/README.ko.md">한국어</a> · <a href="docs/readme/README.vi.md">Tiếng Việt</a> · <a href="docs/readme/README.es.md">Español</a> · <a href="docs/readme/README.pt-BR.md">Português</a> · <a href="docs/readme/README.fr.md">Français</a> · <a href="docs/readme/README.de.md">Deutsch</a> · <a href="docs/readme/README.ru.md">Русский</a></sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="GitHub stars" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS, Windows and Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>


<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac (Apple silicon)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac (Intel)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>or, with Node.js 22: <code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>If Friday saves you time, a ⭐ helps other people find it. Want to help build it? <a href="#contributing">Start here</a>.</sub></p>

<p align="center">
  <img src="docs/assets/site/hero.png" alt="Friday on a sample storefront project: the checkout-v2 thread with a team of three, Amp and Claude Code 2 working while Codex answers whether 3-D Secure is covered by a test, and the Agents panel showing who is done and who is working" width="960" />
</p>

Think of it as a group chat and a task board for your AI coding agents.

- **They talk.** Agents message each other as they work: a heads-up about a rename, a question, the answer. You see every message.
- **They split the work.** One agent turns the job into a shared task board; the others pick up the parts that suit them, each in its own copy of your repo, so nobody overwrites anybody.
- **They check each other.** A finished task is checked by another agent (a different model when one is free), then you read the diff, leave notes on any line, and commit.

And when one agent runs out of usage, another picks up its task with a record of what was done.

<table>
<tr>
<td width="50%"><img src="docs/assets/site/talk.png" alt="Claude Code asks Codex whether the 3-D Secure path on checkout-v2 is covered by a test, and Codex's answer comes back in the chat" /></td>
<td width="50%"><img src="docs/assets/site/board.png" alt="Team tasks: Cursor and Kilo working on guest checkout and the 3-D Secure wait, four more up next, each waiting on the one before" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>They talk.</b> One agent asks another what it found and gets the answer back in the chat.</sub></td>
<td width="50%" valign="top"><sub><b>They split the work.</b> Every task, who has it and where it stands, on one board.</sub></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/site/review.png" alt="Friday IDE: a self-review of checkout.ts with the fixed bug as a note on line 12 and the review card: three fixed, one for you" /></td>
<td width="50%"><img src="docs/assets/site/own-copy.png" alt="Adding Kilo to the storefront repo on its own worktree and branch" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>They check each other.</b> An agent reviews the change and leaves its findings on the lines before you read it.</sub></td>
<td width="50%" valign="top"><sub><b>Each in its own copy.</b> Every agent gets its own worktree and branch, so nobody overwrites anybody.</sub></td>
</tr>
</table>

### Friday IDE

Your editor, terminal and extensions, with every agent's chat beside them. Edit in place with ⌘K, race two or three coding tools on one ask and keep the best, and get a self-review before the pull request.

<p align="center">
  <img src="docs/assets/site/ide.png" alt="Friday IDE: checkout.ts open in the editor, and three coding tools racing one ask in the chat beside it, each with Compare and Keep" width="960" />
</p>

## Get started in five minutes

1. **Sign in to one coding tool** you already use, for example `claude auth login` or `codex login`.
2. **Install Friday** with a download link above, or run `npx github:splashxmoon/friday-code` with Node.js 22.
3. **Open it.** Friday lists the coding tools it found on your computer.
4. **Start a session** in your repo and give it a job.
5. **Review what changed** and keep what you like.

One agent is enough to start. Add a second when you want them to split the work.

## Works with the agents you already pay for

No API keys and no new plan: Friday drives the coding tools signed in on your computer.

<table>
  <tr>
    <td align="center" width="120"><img src="docs/assets/tools/claude.svg" width="32" height="32" alt="" /><br /><sub>Claude Code</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/codex.svg" width="32" height="32" alt="" /><br /><sub>Codex</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/cursor.svg" width="32" height="32" alt="" /><br /><sub>Cursor</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/copilot.svg" width="32" height="32" alt="" /><br /><sub>GitHub Copilot</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/gemini.svg" width="32" height="32" alt="" /><br /><sub>Gemini CLI</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/antigravity.svg" width="32" height="32" alt="" /><br /><sub>Antigravity CLI</sub></td>
  </tr>
  <tr>
    <td align="center" width="120"><img src="docs/assets/tools/opencode.svg" width="32" height="32" alt="" /><br /><sub>OpenCode</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/devin.svg" width="32" height="32" alt="" /><br /><sub>Devin</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/junie.svg" width="32" height="32" alt="" /><br /><sub>Junie</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/kiro.svg" width="32" height="32" alt="" /><br /><sub>Kiro</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/droid.svg" width="32" height="32" alt="" /><br /><sub>Factory Droid</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/grok.svg" width="32" height="32" alt="" /><br /><sub>Grok Build</sub></td>
  </tr>
  <tr>
    <td align="center" width="120"><img src="docs/assets/tools/cline.svg" width="32" height="32" alt="" /><br /><sub>Cline</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/kilo.svg" width="32" height="32" alt="" /><br /><sub>Kilo</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/amp.svg" width="32" height="32" alt="" /><br /><sub>Amp</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/muse.svg" width="32" height="32" alt="" /><br /><sub>Muse Code</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/qwen.svg" width="32" height="32" alt="" /><br /><sub>Qwen Code</sub></td>
    <td align="center" width="120"><img src="docs/assets/tools/pi.svg" width="32" height="32" alt="" /><br /><sub>Pi</sub></td>
  </tr>
  <tr>
    <td align="center" width="120"><img src="docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>Any ACP agent</sub></td>
  </tr>
</table>

## Free, and on your computer

Friday is MIT licensed, has no account and no model of its own, and listens on `127.0.0.1` only. Your code, prompts and files never come to us. The only thing it sends is a few anonymous usage counts, which you can turn off ([what exactly](#privacy)). What we sell is [Friday Team](https://www.tryfridaywork.com), the hosted version for several people in one session.

## More

<details>
<summary><b>Crew: AI teammates with memory</b></summary>

Keep AI teammates on your computer, each with a name, a role, a memory and its own folder, on one of your coding tools. Give the crew a goal and the lead plans it on a board, or `@` one of them. Rooms with side threads, access per teammate (Read only, Ask before changes, Full access), Away until a time (teammates note their assumptions and a brief waits for you; it works while your computer stays on and Friday is running), a backup tool when one runs out, and workflows drawn as steps.

<img src="docs/assets/site/crew-room.png" alt="A crew room: Kit builds the pricing page and reports back to Nova in one card, and Nova sums up" width="960" />
</details>

<details>
<summary><b>Rules, project memory and safety</b></summary>

- **Rules that stick:** tell an agent "never touch the migrations" once and Friday offers it as a rule every agent's later work is checked against.
- **Was it already broken?** A failing test is rerun on the code from before the agent started, so old failures are marked as old.
- **Project memory:** corrections are kept per repo, and every agent that starts there is told them first.
- **Careful by default:** before a command that deletes, deploys, publishes or installs, Don't is the main button. Secrets (API keys, tokens, webhook URLs) are hidden in the chat and the Git panel.
</details>

<details>
<summary><b>Automations, Git and everything else</b></summary>

- **Automations:** on a schedule, a webhook, or when another session finishes; one tool or several splitting the work; ends in a pull request for you to review.
- **Git built in:** stage by hunk, commit, push, open a PR.
- **Friday Code:** Friday's own agent, on an API key of yours or a local model (Ollama, LM Studio).
- **Let other agents use Friday:** Claude Code, Codex or any MCP client on your computer can start Friday sessions and hand them work (`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`).
- Live feed, rewind, dev-server preview, terminal, ⌘K for everything, themes, notifications.
</details>

<details>
<summary><b>Install details: every tool's install and sign-in, Homebrew, settings</b></summary>

### Supported Tools and Installation

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| Tools | Installation | Sign-in |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | run `gemini` once and sign in |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` once and sign in |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | Signs in on its own first screen |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | Signs in on its own first screen |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | run `qwen` once and sign in |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | run `pi` once and type `/login` (or set a provider's API key) |
| **Other ACP agent** | any ACP agent | any ACP agent |

### The desktop app

| | |
| --- | --- |
| Mac, Apple silicon | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac, Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage) (`chmod +x` it, then run it) |

On a Mac, Homebrew installs it too:

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

Every version is on the [releases page](https://github.com/splashxmoon/friday-code/releases). The app is Friday in a window of its own, with the same server inside it, on `127.0.0.1` only.

The Mac app is signed and notarized by Apple, so it opens like any other.

> [!NOTE]
> The Windows installer isn't signed yet, so Windows asks before running it the first time: choose **More info**, then **Run anyway**.

### From a terminal

With Node.js 22 or newer and Git:

```bash
npx github:splashxmoon/friday-code
```

Friday opens in your browser at `http://127.0.0.1:4321`. To keep a copy:

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| Setting | Default | What it does |
| --- | --- | --- |
| `PORT` | `4321` | Where Friday listens, on this computer only. |
| `FRIDAY_HOME` | `~/.friday` | Where it keeps your sessions and settings. |
| `--no-open` | | Start without opening the browser. |
</details>

<details>
<summary id="privacy"><b>Privacy: exactly what's sent</b></summary>

Friday listens on `127.0.0.1` only, so nothing else on your network can reach it, and it answers only its own page: a request from any other site, or from a page being previewed, is refused. What it keeps is one folder on your computer, readable only by you.

It has no account, and your code, prompts and files never come to us. What it does send is a few anonymous usage counts, so we can see whether people get Friday working and keep using it. Every one of them goes to [PostHog](https://posthog.com) over HTTPS, with IP-based location and person profiles turned off; a send that fails is dropped. The code is all in [`src/usage.ts`](src/usage.ts).

- A random id made on your computer for this install, tied to nothing else.
- Friday's version, your system (macOS, Windows or Linux) and its architecture, and whether it's the desktop app.
- Once a day you open it: that you did, the names of the coding tools it found, and how many are signed in.
- Each session started, and whether it's a Code or Crew one.
- Once each: the first time a coding tool is ready, and the first time an agent finishes a turn.

Never: prompts, code, file names or paths, repository names, email addresses, accounts or sign-ins, or anything a tool writes. Friday asks about the counts in its welcome the first time it opens (or in a note in the sidebar, if you skip the welcome), and sends nothing before you answer. To turn them off, use Settings › Data & backup › Share anonymous usage, or set `FRIDAY_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` where Friday runs.

It talks to GitHub for the pull requests, issues and skills you ask it about. Each tool's remaining usage comes from the tool itself wherever it can: Claude Code's from what it reports as it runs (its sign-in is never read), Codex's from its own app server, Copilot's through your GitHub CLI. Cursor keeps none on your computer, so Friday makes the request Cursor's own CLI makes, to Cursor's server and nowhere else. For the other tools that keep a sign-in on your computer (Kilo, OpenCode, Grok, Factory Droid, Antigravity, Cline, Amp and a few more), Friday reads it there only to ask that tool's own server how much usage you have left. It goes nowhere else, never to us, and never into the usage counts. Friday never switches the account a tool is signed in with. A model you add in Settings › Your models is called from your computer, and its key is kept there and sent only to that model's own server. The desktop app also asks GitHub for a newer release while it's open (when it starts, when you come back to it, and every ten minutes), downloads it from there, and installs it when you restart (`FRIDAY_NO_UPDATE_CHECK=1` turns that off).

</details>

<details>
<summary><b>FAQ</b></summary>

**How do I run Claude Code and Codex at the same time on one project?**
Start a session in your repository with one of them, then add the other from the session's agent bar. Each can work in its own copy of the repository (a Git worktree), so they don't overwrite each other, and Friday keeps them talking.

**Is this a multi-agent framework I have to code against?**
No. Friday drives the coding CLIs you already use, as they are. There's nothing to write: you pick the tools and give them the job.

**Can I start with just one agent?**
Yes. A session with one coding tool works like that tool with Friday's review, Git and preview around it. Add a second agent whenever you want them to split the work.

**Does it work on my existing repo?**
Yes. Point a session at any folder or repository on your computer. Agents you add can each work in their own Git worktree of it, and Friday won't switch a folder with uncommitted work out from under you.

**Do I need an account, a server, or a new subscription?**
No. Friday runs on your computer at `127.0.0.1`, with no account, and the work runs on the coding tools you're already signed in to.

**What if a coding tool isn't installed?**
Friday only uses the tools it finds. Its setup screen shows which are installed and signed in, and can sign the rest in for you.

**Which coding agents does it support?**
Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity CLI, OpenCode, Devin CLI, Junie, Kiro, Factory Droid, Grok Build, Cline, Kilo Code, Amp, Muse Code, and any agent that speaks the Agent Client Protocol (ACP).

**Does it cost anything, or use my API keys?**
Friday is free and MIT licensed. The work runs on each tool's own plan and sign-in, so there are no keys to paste and nothing extra to pay. If you'd like Friday Code, Friday's own agent, too, give it a key of yours or a model on your computer in Settings › Your models: then it runs on that.

**What happens when one agent runs out of usage?**
Its task goes to the agent best placed to finish it, with a record of what the first did and changed, so the work keeps going.

**Can it run my agents while I'm not there?**
Yes: an automation starts a coding tool on a schedule, from a webhook, or when another session finishes, and opens a pull request for you to review. Friday has to be running for it to start; you choose whether a run missed while the computer was off happens when it's back.

**Does my code leave my computer?**
Not through Friday. It runs on `127.0.0.1` with no account; your coding tools talk to their own providers as they always do. The only things Friday sends us are the anonymous usage counts under [Privacy](#privacy), which never include code, and you can turn them off.
</details>

## Contributing

Friday is built in the open and every pull request gets a reply within a day. Good places to start:

- **Add a coding tool.** Most tools are a short adapter: [goose](https://github.com/splashxmoon/friday-code/issues/36), [Auggie](https://github.com/splashxmoon/friday-code/issues/37), [Aider](https://github.com/splashxmoon/friday-code/issues/38) and [Crush](https://github.com/splashxmoon/friday-code/issues/39) are waiting, and [the guide](docs/adding-a-coding-tool.md) walks through one.
- **Package it.** [Scoop](https://github.com/splashxmoon/friday-code/issues/41) for Windows, [the AUR](https://github.com/splashxmoon/friday-code/issues/40) for Arch.
- **Try it and report.** [The Linux AppImage on your distro](https://github.com/splashxmoon/friday-code/issues/4), [MCP sign-in on Windows and Linux](https://github.com/splashxmoon/friday-code/issues/26).
- **Something else?** [Start here](https://github.com/splashxmoon/friday-code/issues/42), the [good first issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue), or an idea in [Discussions](https://github.com/splashxmoon/friday-code/discussions).

To build it: `npm install`, `npm start` (or `npm run desktop`), `npm test`. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest. Every release note thanks the people whose work is in it.

Thanks to everyone who has helped build Friday:

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Friday's contributors" /></a>

If Friday saves you time, a ⭐ helps other developers find it.

## License

[MIT](LICENSE)
