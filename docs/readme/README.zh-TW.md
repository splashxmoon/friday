<p align="center">
  <img src="../../docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>一個 App，管好你所有的 AI 程式代理。</strong><br/>
  Claude Code、Codex、Cursor 以及另外 15 款工具，直接用你已經付費的訂閱。讓它們並排執行，或交給它們一項任務：它們會分工、互相審查，一個用完額度時另一個接手。免費開源，在你自己的電腦上執行。
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>繁體中文</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a></sub></p>

<p align="center"><sub>本文譯自英文 README。若內容有出入，以英文版為準。</sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="GitHub 星星" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="授權：MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS、Windows 和 Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac（Apple 晶片）</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac（Intel）</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>或者，在 Node.js 22 下執行：<code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>如果 Friday 幫你省下時間，給個 ⭐ 能讓更多人找到它。想一起開發？<a href="#contributing">從這裡開始</a>。</sub></p>

<p align="center">
  <img src="../../docs/assets/site/hero.png" alt="Friday 開著一個範例網路商店專案：checkout-v2 討論串裡有一個三人小組，Amp 和 Claude Code 2 正在工作，Codex 在回答 3-D Secure 是否有測試涵蓋；Agents 面板顯示誰已完成、誰在工作" width="960" />
</p>

你可以把它想成 AI 程式代理的群組聊天加任務看板。

- **它們會溝通。** 代理在工作時互相傳訊息：提醒一次重新命名、提出一個問題、給出答案。每則訊息你都看得到。
- **它們會分工。** 一個代理把任務拆成共用的任務看板，其他代理認領適合自己的部分，各自在你儲存庫的獨立副本裡工作，誰也不會覆蓋誰。
- **它們會互相檢查。** 一個任務完成後，由另一個代理檢查（有空檔時換一個不同的模型），接著你閱讀 diff，在任何一行留下註記，再提交。

當一個代理用完額度時，另一個會接手它的任務，並附上一份已完成工作的紀錄。

<table>
<tr>
<td width="50%"><img src="../../docs/assets/site/talk.png" alt="Claude Code 詢問 Codex：checkout-v2 上的 3-D Secure 流程有沒有測試涵蓋，Codex 的回答出現在聊天中" /></td>
<td width="50%"><img src="../../docs/assets/site/board.png" alt="團隊任務：Cursor 和 Kilo 正在處理訪客結帳和 3-D Secure 等待，另有四個任務排在後面，每個都等前一個完成" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>它們會溝通。</b>一個代理問另一個發現了什麼，答案直接回到聊天裡。</sub></td>
<td width="50%" valign="top"><sub><b>它們會分工。</b>每個任務、由誰負責、進度如何，都在一個看板上。</sub></td>
</tr>
<tr>
<td width="50%"><img src="../../docs/assets/site/review.png" alt="Friday IDE：checkout.ts 的自我審查，修好的 bug 以註記標在第 12 行，審查卡片顯示：已修正三處，一處留給你" /></td>
<td width="50%"><img src="../../docs/assets/site/own-copy.png" alt="把 Kilo 加入 storefront 儲存庫，使用它自己的 worktree 和分支" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>它們會互相檢查。</b>在你閱讀之前，一個代理先審查變更，把發現留在對應的行上。</sub></td>
<td width="50%" valign="top"><sub><b>各用各的副本。</b>每個代理都有自己的 worktree 和分支，誰也不會覆蓋誰。</sub></td>
</tr>
</table>

### Friday IDE

你的編輯器、終端機和擴充功能，旁邊是每個代理的聊天。用 ⌘K 就地編輯，讓兩三個程式工具同時處理一個請求並留下最好的結果，在送出 pull request 之前先做一次自我審查。

<p align="center">
  <img src="../../docs/assets/site/ide.png" alt="Friday IDE：編輯器中開著 checkout.ts，旁邊的聊天裡三個程式工具同時處理一個請求，每個都附有 Compare 和 Keep" width="960" />
</p>

## 五分鐘上手

1. **登入一個你已經在用的程式工具**，例如 `claude auth login` 或 `codex login`。
2. **安裝 Friday**：使用上方的下載連結，或在 Node.js 22 下執行 `npx github:splashxmoon/friday-code`。
3. **打開它。** Friday 會列出它在你電腦上找到的程式工具。
4. **在你的儲存庫裡開始一個工作階段**，交給它一項任務。
5. **檢視變更**，留下你滿意的部分。

一個代理就足以起步。想讓它們分工時，再加第二個。

## 支援你已經付費的代理

不需要 API 金鑰，也不需要新方案：Friday 驅動的是你電腦上已登入的程式工具。

<table>
  <tr>
    <td align="center" width="120"><img src="../../docs/assets/tools/claude.svg" width="32" height="32" alt="" /><br /><sub>Claude Code</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/codex.svg" width="32" height="32" alt="" /><br /><sub>Codex</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/cursor.svg" width="32" height="32" alt="" /><br /><sub>Cursor</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/copilot.svg" width="32" height="32" alt="" /><br /><sub>GitHub Copilot</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/gemini.svg" width="32" height="32" alt="" /><br /><sub>Gemini CLI</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/antigravity.svg" width="32" height="32" alt="" /><br /><sub>Antigravity CLI</sub></td>
  </tr>
  <tr>
    <td align="center" width="120"><img src="../../docs/assets/tools/opencode.svg" width="32" height="32" alt="" /><br /><sub>OpenCode</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/devin.svg" width="32" height="32" alt="" /><br /><sub>Devin</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/junie.svg" width="32" height="32" alt="" /><br /><sub>Junie</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/kiro.svg" width="32" height="32" alt="" /><br /><sub>Kiro</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/droid.svg" width="32" height="32" alt="" /><br /><sub>Factory Droid</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/grok.svg" width="32" height="32" alt="" /><br /><sub>Grok Build</sub></td>
  </tr>
  <tr>
    <td align="center" width="120"><img src="../../docs/assets/tools/cline.svg" width="32" height="32" alt="" /><br /><sub>Cline</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/kilo.svg" width="32" height="32" alt="" /><br /><sub>Kilo</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/amp.svg" width="32" height="32" alt="" /><br /><sub>Amp</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/muse.svg" width="32" height="32" alt="" /><br /><sub>Muse Code</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/qwen.svg" width="32" height="32" alt="" /><br /><sub>Qwen Code</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/pi.svg" width="32" height="32" alt="" /><br /><sub>Pi</sub></td>
  </tr>
  <tr>
    <td align="center" width="120"><img src="../../docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>任何 ACP 代理</sub></td>
  </tr>
</table>

## 免費，而且在你的電腦上執行

Friday 採用 MIT 授權，沒有帳號，也沒有自己的模型，只監聽 `127.0.0.1`。你的程式碼、提示詞和檔案絕不會傳給我們。它唯一傳送的是少量匿名使用統計，你可以關閉（[具體內容](#privacy)）。我們販售的是 [Friday Team](https://www.tryfridaywork.com)，也就是讓多人在同一個工作階段中協作的託管版本。

## 更多

<details>
<summary><b>Crew：有記憶的 AI 隊友</b></summary>

在你的電腦上組一支 AI 隊友，每位都有名字、角色、記憶和自己的資料夾，在你的某個程式工具上執行。給 crew 一個目標，負責人會在看板上擬好計畫；也可以直接 `@` 其中一位。支援：帶有分支討論串的房間；依隊友設定權限（唯讀、變更前先詢問、完整存取）；離開到指定時間（隊友會記下自己的假設，等你回來時有一份簡報在等你；前提是電腦保持開機且 Friday 正在執行）；一個工具用完額度時的備援工具；以及按步驟繪製的工作流程。

<img src="../../docs/assets/site/crew-room.png" alt="一個 crew 房間：Kit 製作定價頁面，並用一張卡片向 Nova 回報，Nova 做了總結" width="960" />
</details>

<details>
<summary><b>規則、專案記憶與安全</b></summary>

- **規則會一直有效：** 對代理說一次「永遠別碰 migrations」，Friday 就會把它提議為一條規則，之後每個代理的工作都會依它檢查。
- **是不是本來就壞了？** 失敗的測試會在代理開始之前的程式碼上重跑一次，原本就有的失敗會標記為舊問題。
- **專案記憶：** 修正意見依儲存庫保存，每個在該儲存庫啟動的代理都會先收到它們。
- **預設謹慎：** 在執行刪除、部署、發布或安裝類的指令之前，主要按鈕是 Don't（不執行）。機密資訊（API 金鑰、token、webhook URL）在聊天和 Git 面板中會被隱藏。
</details>

<details>
<summary><b>自動化、Git 及其他</b></summary>

- **自動化：** 依排程、由 webhook 觸發，或在另一個工作階段結束時啟動；可以用一個工具，也可以讓幾個工具分工；最後產出一個 pull request 讓你審查。
- **內建 Git：** 依 hunk 暫存、提交、推送、開 PR。
- **Friday Code：** Friday 自己的代理，使用你自己的 API 金鑰或本機模型（Ollama、LM Studio）。
- **讓其他代理使用 Friday：** 你電腦上的 Claude Code、Codex 或任何 MCP 用戶端都能啟動 Friday 工作階段並把工作交給它（`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`）。
- 即時動態、倒回、開發伺服器預覽、終端機、用 ⌘K 完成所有操作、佈景主題、通知。
</details>

<details>
<summary><b>安裝細節：各工具的安裝與登入、Homebrew、設定</b></summary>

### 支援的工具與安裝

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| 工具 | 安裝 | 登入 |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | 執行一次 `gemini` 並登入 |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | 執行一次 `agy` 並登入 |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | 在它自己的第一個畫面登入 |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | 在它自己的第一個畫面登入 |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | 執行一次 `qwen` 並登入 |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | 執行一次 `pi` 並輸入 `/login`（或設定某個供應商的 API 金鑰） |
| **其他 ACP 代理** | 任何 ACP 代理 | 任何 ACP 代理 |

### 桌面 App

| | |
| --- | --- |
| Mac，Apple 晶片 | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac，Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage)（先 `chmod +x`，再執行） |

在 Mac 上也可以用 Homebrew 安裝：

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

所有版本都在[發行頁面](https://github.com/splashxmoon/friday-code/releases)上。這個 App 就是在獨立視窗中執行的 Friday，內建同樣的伺服器，同樣只監聽 `127.0.0.1`。

Mac App 已經過 Apple 簽署與公證，開啟方式和其他 App 一樣。

> [!NOTE]
> Windows 安裝程式尚未簽署，所以第一次執行時 Windows 會先詢問：選擇 **其他資訊**，再選擇 **仍要執行**。

### 從終端機執行

需要 Node.js 22 或更新版本，以及 Git：

```bash
npx github:splashxmoon/friday-code
```

Friday 會在瀏覽器中開啟 `http://127.0.0.1:4321`。想在本機保留一份：

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| 設定 | 預設值 | 用途 |
| --- | --- | --- |
| `PORT` | `4321` | Friday 監聽的埠，只限本機。 |
| `FRIDAY_HOME` | `~/.friday` | 存放你的工作階段和設定的位置。 |
| `--no-open` | | 啟動時不開啟瀏覽器。 |
</details>

<details>
<summary id="privacy"><b>隱私：到底傳送了什麼</b></summary>

Friday 只監聽 `127.0.0.1`，所以你網路上的其他裝置都無法連到它。它也只回應自己的頁面：來自其他任何網站或正在預覽的頁面的請求都會被拒絕。它保存的只有你電腦上的一個資料夾，而且只有你能讀取。

它沒有帳號，你的程式碼、提示詞和檔案絕不會傳給我們。它確實會傳送少量匿名使用統計，讓我們了解大家能否順利用起 Friday、是否會繼續使用。所有統計都透過 HTTPS 傳到 [PostHog](https://posthog.com)，並關閉了以 IP 判斷位置和個人檔案的功能；傳送失敗的資料會直接捨棄。相關程式碼全部在 [`src/usage.ts`](../../src/usage.ts) 中。

- 一個在你電腦上為這次安裝產生的隨機 ID，不與任何其他資訊綁定。
- Friday 的版本、你的系統（macOS、Windows 或 Linux）及其架構，以及是否為桌面 App。
- 你開啟它的日子，每天一次：你開啟了它、它找到的程式工具名稱，以及其中有幾個已登入。
- 每次開始工作階段，以及它是 Code 還是 Crew 工作階段。
- 各記錄一次：第一次有程式工具準備就緒，以及第一次有代理完成一輪工作。

絕不傳送：提示詞、程式碼、檔名或路徑、儲存庫名稱、電子郵件地址、帳號或登入資訊，以及工具寫出的任何內容。Friday 第一次開啟時會在歡迎畫面詢問你是否同意這些統計（如果你略過歡迎畫面，則在側邊欄以提示詢問），在你回答之前不會傳送任何東西。要關閉統計，可以使用 Settings › Data & backup › Share anonymous usage，或在執行 Friday 的環境中設定 `FRIDAY_NO_TELEMETRY=1` 或 `DO_NOT_TRACK=1`。

當你詢問 pull request、issue 和技能時，它會與 GitHub 溝通。每個工具的剩餘額度盡可能從工具本身取得：Claude Code 的來自它執行時的回報（絕不讀取它的登入資訊），Codex 的來自它自己的 app server，Copilot 的透過你的 GitHub CLI 取得。Cursor 不在你的電腦上保存這些資訊，所以 Friday 會發出與 Cursor 自己的 CLI 相同的請求，只傳到 Cursor 的伺服器，不會傳到別處。對於其他在你電腦上保存登入資訊的工具（Kilo、OpenCode、Grok、Factory Droid、Antigravity、Cline、Amp 等），Friday 只在本機讀取登入資訊，用來向該工具自己的伺服器查詢你還剩多少額度。這些資訊不會傳到別處，絕不會傳給我們，也絕不會進入使用統計。Friday 絕不切換工具所登入的帳號。你在 Settings › Your models 中加入的模型從你的電腦直接呼叫，它的金鑰保存在本機，只傳給該模型自己的伺服器。桌面 App 在開啟期間也會向 GitHub 查詢新版本（啟動時、你切回 App 時，以及每十分鐘一次），從 GitHub 下載，並在你重新啟動時安裝（設定 `FRIDAY_NO_UPDATE_CHECK=1` 可關閉）。

</details>

<details>
<summary><b>常見問題</b></summary>

**怎麼在同一個專案上同時執行 Claude Code 和 Codex？**
先用其中一個在你的儲存庫裡開始工作階段，再從工作階段的代理列加入另一個。它們各自可以在儲存庫的獨立副本（Git worktree）中工作，不會互相覆蓋，Friday 會讓它們保持溝通。

**這是一個需要我寫程式去串接的多代理框架嗎？**
不是。Friday 直接驅動你已經在用的程式 CLI，原樣使用。完全不用寫程式：你挑好工具，把任務交給它們就好。

**可以只用一個代理開始嗎？**
可以。只有一個程式工具的工作階段，用起來就像那個工具本身，再加上 Friday 的審查、Git 和預覽。想讓它們分工時，隨時再加第二個代理。

**能用在我現有的儲存庫上嗎？**
可以。把工作階段指向你電腦上的任何資料夾或儲存庫就行。你加入的每個代理都可以在它的 Git worktree 中工作；如果某個資料夾裡有尚未提交的變更，Friday 不會在你不知情時切換它。

**需要帳號、伺服器或新的訂閱嗎？**
不需要。Friday 在你的電腦上以 `127.0.0.1` 執行，沒有帳號，工作都由你已經登入的程式工具完成。

**如果某個程式工具沒有安裝呢？**
Friday 只使用它找到的工具。它的設定畫面會顯示哪些已安裝、哪些已登入，也能幫你登入其餘的工具。

**支援哪些 AI 程式代理？**
Claude Code、Codex、Cursor、GitHub Copilot、Gemini CLI、Antigravity CLI、OpenCode、Devin CLI、Junie、Kiro、Factory Droid、Grok Build、Cline、Kilo Code、Amp、Muse Code，以及任何支援 Agent Client Protocol（ACP）的代理。

**要花錢嗎？會用到我的 API 金鑰嗎？**
Friday 免費，採用 MIT 授權。工作使用每個工具自己的方案和登入，所以不用貼上金鑰，也不用額外付費。如果你還想用 Friday 自己的代理 Friday Code，可以在 Settings › Your models 中給它一把你自己的金鑰或你電腦上的模型，它就會用那個來執行。

**一個代理用完額度時會怎樣？**
它的任務會交給最適合完成的代理，並附上第一個代理做過什麼、改了什麼的紀錄，工作不會中斷。

**我不在的時候，它能執行我的代理嗎？**
可以。自動化能依排程、由 webhook 觸發，或在另一個工作階段結束時啟動一個程式工具，並開一個 pull request 讓你審查。Friday 必須正在執行才能啟動它；電腦關機期間錯過的執行，開機後要不要補跑由你決定。

**我的程式碼會離開我的電腦嗎？**
不會經過 Friday。它在 `127.0.0.1` 執行，沒有帳號；你的程式工具照常與它們各自的服務供應商溝通。Friday 傳給我們的只有[隱私](#privacy)中列出的匿名使用統計，其中絕不包含程式碼，而且你可以關閉。
</details>

<a id="contributing"></a>
## 參與貢獻

Friday 公開開發，每個 pull request 都會在一天內得到回覆。適合入門的地方：

- **加入一個程式工具。** 大多數工具只需要一個簡短的轉接器：[goose](https://github.com/splashxmoon/friday-code/issues/36)、[Auggie](https://github.com/splashxmoon/friday-code/issues/37)、[Aider](https://github.com/splashxmoon/friday-code/issues/38) 和 [Crush](https://github.com/splashxmoon/friday-code/issues/39) 正等著有人來做，[這份指南](../../docs/adding-a-coding-tool.md)會帶你完整做一次。
- **打包。** Windows 的 [Scoop](https://github.com/splashxmoon/friday-code/issues/41)，Arch 的 [AUR](https://github.com/splashxmoon/friday-code/issues/40)。
- **試用並回報。** [在你的發行版上執行 Linux AppImage](https://github.com/splashxmoon/friday-code/issues/4)，[Windows 和 Linux 上的 MCP 登入](https://github.com/splashxmoon/friday-code/issues/26)。
- **想做別的？** [從這裡開始](https://github.com/splashxmoon/friday-code/issues/42)，看看 [good first issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue)，或在 [Discussions](https://github.com/splashxmoon/friday-code/discussions) 提出想法。

建置方式：`npm install`、`npm start`（或 `npm run desktop`）、`npm test`。其餘內容請見 [CONTRIBUTING.md](../../CONTRIBUTING.md)。每份發行說明都會感謝為該版本出力的人。

感謝所有幫忙打造 Friday 的人：

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Friday 的貢獻者" /></a>

如果 Friday 幫你省下時間，給個 ⭐ 能讓更多開發者找到它。

## 授權

[MIT](../../LICENSE)
