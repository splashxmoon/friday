<p align="center">
  <img src="../../docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>すべてのコーディングエージェントを、ひとつのアプリで。</strong><br/>
  Claude Code、Codex、Cursor ほか 15 種類を、すでに契約しているサブスクリプションのまま使えます。並べて同時に動かすことも、仕事をまとめて任せることもできます。任せると、エージェント同士で仕事を分け、互いの作業をレビューし、どれかの使用量が尽きたら別のエージェントが引き継ぎます。無料のオープンソースで、あなたのコンピューター上で動きます。
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <b>日本語</b> · <a href="README.ko.md">한국어</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a></sub></p>
<p align="center"><sub>英語版 README からの翻訳です。内容が異なる場合は英語版が最新です。</sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="GitHub スター" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="ライセンス: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS、Windows、Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac（Apple シリコン）</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac（Intel）</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>または Node.js 22 で：<code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>Friday で時間が浮いたら、⭐ をもらえるとほかの人が見つけやすくなります。開発に参加したい方は<a href="#contributing">こちらから</a>。</sub></p>

<p align="center">
  <img src="../../docs/assets/site/hero.png" alt="サンプルのストアフロントプロジェクトで動く Friday：3 人のチームがいる checkout-v2 スレッド。Amp と Claude Code 2 が作業し、Codex は 3-D Secure がテストでカバーされているかに答えている。Agents パネルには、誰が完了して誰が作業中かが表示されている" width="960" />
</p>

AI コーディングエージェントのためのグループチャットとタスクボード、と考えてください。

- **会話する。** エージェントは作業しながらメッセージを送り合います。名前変更の事前連絡、質問、その答え。すべてのメッセージがあなたにも見えます。
- **仕事を分ける。** 1 つのエージェントが仕事を共有のタスクボードに分解し、ほかのエージェントが得意な部分を引き受けます。それぞれがリポジトリの専用コピーで作業するので、誰かの変更を上書きすることはありません。
- **互いにチェックする。** 終わったタスクは別のエージェントがチェックします（空いていれば別のモデルで）。そのあとあなたが diff を読み、好きな行にメモを残して、コミットします。

さらに、あるエージェントの使用量が尽きたら、別のエージェントがそれまでの作業記録を受け取ってタスクを引き継ぎます。

<table>
<tr>
<td width="50%"><img src="../../docs/assets/site/talk.png" alt="Claude Code が Codex に、checkout-v2 の 3-D Secure の処理がテストでカバーされているかを尋ね、Codex の答えがチャットに返ってくる" /></td>
<td width="50%"><img src="../../docs/assets/site/board.png" alt="チームのタスク：Cursor と Kilo がゲストチェックアウトと 3-D Secure の待機処理に取り組み、次に控えるタスクが 4 つ。それぞれが前のタスクを待っている" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>会話する。</b> あるエージェントが別のエージェントに調べた結果を尋ね、答えがチャットに返ってきます。</sub></td>
<td width="50%" valign="top"><sub><b>仕事を分ける。</b> すべてのタスクと、その担当者、進み具合をひとつのボードで。</sub></td>
</tr>
<tr>
<td width="50%"><img src="../../docs/assets/site/review.png" alt="Friday IDE：checkout.ts のセルフレビュー。修正したバグが 12 行目のメモになり、レビューカードには「3 件修正、1 件はあなたへ」とある" /></td>
<td width="50%"><img src="../../docs/assets/site/own-copy.png" alt="Kilo を storefront リポジトリに追加し、専用の worktree とブランチを用意している" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>互いにチェックする。</b> あなたが読む前に、エージェントが変更をレビューし、指摘を該当する行に残します。</sub></td>
<td width="50%" valign="top"><sub><b>それぞれ専用のコピーで。</b> エージェントごとに専用の worktree とブランチがあるので、誰かの変更を上書きすることはありません。</sub></td>
</tr>
</table>

### Friday IDE

いつものエディター、ターミナル、拡張機能の横に、すべてのエージェントのチャットが並びます。⌘K でその場で編集でき、1 つの依頼を 2〜3 個のコーディングツールに競わせて一番良いものを残せます。プルリクエストの前にはセルフレビューも受けられます。

<p align="center">
  <img src="../../docs/assets/site/ide.png" alt="Friday IDE：エディターで checkout.ts を開き、横のチャットでは 3 つのコーディングツールが 1 つの依頼を競っている。それぞれに Compare と Keep がある" width="960" />
</p>

## 5 分で始める

1. **普段使っているコーディングツールに 1 つサインインします。** 例：`claude auth login` や `codex login`。
2. **Friday をインストールします。** 上のダウンロードリンクを使うか、Node.js 22 で `npx github:splashxmoon/friday-code` を実行します。
3. **開きます。** Friday が、コンピューター上で見つけたコーディングツールを一覧表示します。
4. **セッションを始めます。** リポジトリでセッションを開始し、仕事を渡します。
5. **変更を確認します。** 気に入ったものを残します。

始めるにはエージェント 1 つで十分です。仕事を分けたくなったら 2 つ目を追加してください。

## いま払っているエージェントで動く

API キーも新しいプランも要りません。Friday は、コンピューターでサインイン済みのコーディングツールを動かします。

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
    <td align="center" width="120"><img src="../../docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>任意の ACP エージェント</sub></td>
  </tr>
</table>

## 無料で、あなたのコンピューター上で

Friday は MIT ライセンスです。アカウントも独自のモデルもなく、`127.0.0.1` でのみ待ち受けます。あなたのコード、プロンプト、ファイルが私たちに届くことはありません。送信するのはいくつかの匿名の利用カウントだけで、これはオフにできます（[具体的な内容](#privacy)）。私たちが販売しているのは [Friday Team](https://www.tryfridaywork.com) で、複数人で 1 つのセッションを使うためのホスト版です。

## その他

<details>
<summary><b>Crew：記憶を持つ AI チームメイト</b></summary>

AI チームメイトをコンピューター上に置いておけます。それぞれに名前、役割、記憶、専用のフォルダーがあり、あなたのコーディングツールのどれかで動きます。Crew に目標を渡すとリーダーがボード上で計画を立てます。`@` で 1 人を指名することもできます。サイドスレッド付きのルーム、チームメイトごとの権限（Read only、Ask before changes、Full access）、指定時刻までの Away（チームメイトは前提を書き留め、あなた向けの要約が用意されます。コンピューターが起きていて Friday が動いている間に機能します）、ツールの使用量が尽きたときの予備ツール、ステップとして描くワークフローがあります。

<img src="../../docs/assets/site/crew-room.png" alt="Crew のルーム：Kit が料金ページを作って Nova に 1 枚のカードで報告し、Nova がまとめる" width="960" />
</details>

<details>
<summary><b>ルール、プロジェクトの記憶、安全性</b></summary>

- **残るルール：** エージェントに一度「migrations には絶対に触らないで」と伝えると、Friday がそれをルールとして提案します。以降のすべてのエージェントの作業は、このルールに照らしてチェックされます。
- **もともと壊れていた？** 失敗したテストは、エージェントが作業を始める前のコードで再実行されます。前から失敗していたものは、前からの失敗として表示されます。
- **プロジェクトの記憶：** 訂正はリポジトリごとに保存され、そこで始まるすべてのエージェントに最初に伝えられます。
- **標準で慎重：** 削除、デプロイ、公開、インストールを行うコマンドの前では、Don't がメインのボタンになります。シークレット（API キー、トークン、webhook URL）は、チャットと Git パネルで伏せて表示されます。
</details>

<details>
<summary><b>Automations、Git、そのほか全部</b></summary>

- **Automations：** スケジュール、webhook、または別のセッションの終了をきっかけに動きます。1 つのツールでも、複数のツールで仕事を分けても構いません。最後は、あなたがレビューするプルリクエストになります。
- **Git を内蔵：** hunk 単位のステージ、コミット、プッシュ、PR の作成。
- **Friday Code：** Friday 独自のエージェント。あなたの API キーか、ローカルモデル（Ollama、LM Studio）で動きます。
- **ほかのエージェントから Friday を使う：** コンピューター上の Claude Code、Codex、または任意の MCP クライアントが、Friday のセッションを開始して仕事を渡せます（`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`）。
- ライブフィード、巻き戻し、開発サーバーのプレビュー、ターミナル、何でもできる ⌘K、テーマ、通知。
</details>

<details>
<summary><b>インストールの詳細：各ツールのインストールとサインイン、Homebrew、設定</b></summary>

### 対応ツールとインストール

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| ツール | インストール | サインイン |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | `gemini` を一度実行してサインイン |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `agy` を一度実行してサインイン |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | ツール自身の最初の画面でサインイン |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | ツール自身の最初の画面でサインイン |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | `qwen` を一度実行してサインイン |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | `pi` を一度実行して `/login` と入力（またはプロバイダーの API キーを設定） |
| **その他の ACP エージェント** | 任意の ACP エージェント | 任意の ACP エージェント |

### デスクトップアプリ

| | |
| --- | --- |
| Mac（Apple シリコン） | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac（Intel） | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage)（`chmod +x` してから実行） |

Mac では Homebrew でもインストールできます：

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

すべてのバージョンは[リリースページ](https://github.com/splashxmoon/friday-code/releases)にあります。このアプリは Friday を専用のウィンドウで開いたもので、中では同じサーバーが `127.0.0.1` でのみ動いています。

Mac アプリは Apple の署名と公証を受けているので、ほかのアプリと同じように開けます。

> [!NOTE]
> Windows インストーラーはまだ署名されていないため、初めて実行するときに Windows が確認を求めます。**詳細情報**（More info）を選び、次に **実行**（Run anyway）を選んでください。

### ターミナルから

Node.js 22 以降と Git があれば：

```bash
npx github:splashxmoon/friday-code
```

Friday がブラウザーで `http://127.0.0.1:4321` に開きます。手元にコピーを置いておくなら：

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| 設定 | 既定値 | 内容 |
| --- | --- | --- |
| `PORT` | `4321` | Friday が待ち受けるポート。このコンピューターからのみ使えます。 |
| `FRIDAY_HOME` | `~/.friday` | セッションと設定を保存する場所。 |
| `--no-open` | | ブラウザーを開かずに起動します。 |
</details>

<details>
<summary id="privacy"><b>プライバシー：送信される内容のすべて</b></summary>

Friday は `127.0.0.1` でのみ待ち受けるので、同じネットワーク上のほかの機器からはアクセスできません。また、応答するのは自分自身のページだけです。ほかのサイトや、プレビュー中のページからのリクエストは拒否されます。保存するのはコンピューター上の 1 つのフォルダーだけで、あなただけが読めます。

アカウントはなく、あなたのコード、プロンプト、ファイルが私たちに届くことはありません。送信するのはいくつかの匿名の利用カウントだけです。Friday を動かせているか、使い続けているかを知るためのものです。すべて HTTPS で [PostHog](https://posthog.com) に送られ、IP による位置情報と個人プロファイルはオフにしています。送信に失敗したものは破棄されます。コードはすべて [`src/usage.ts`](../../src/usage.ts) にあります。

- このインストール用にコンピューター上で作るランダムな ID。ほかの何とも結び付いていません。
- Friday のバージョン、システム（macOS、Windows、Linux）とそのアーキテクチャ、デスクトップアプリかどうか。
- 開いた日ごとに 1 回：開いたこと、見つかったコーディングツールの名前、そのうちサインイン済みの数。
- 開始した各セッションと、それが Code か Crew か。
- それぞれ 1 回だけ：コーディングツールが初めて準備できたとき、エージェントが初めてターンを終えたとき。

送らないもの：プロンプト、コード、ファイル名やパス、リポジトリ名、メールアドレス、アカウントやサインイン情報、ツールが書き出すものすべて。Friday は初回起動時のウェルカム画面で（ウェルカムを飛ばした場合はサイドバーのメモで）カウントについて尋ね、あなたが答えるまで何も送りません。オフにするには Settings › Data & backup › Share anonymous usage を使うか、Friday を動かす環境で `FRIDAY_NO_TELEMETRY=1` または `DO_NOT_TRACK=1` を設定します。

あなたが尋ねたプルリクエスト、issue、スキルについては GitHub と通信します。各ツールの残り使用量は、できる限りそのツール自身から取得します。Claude Code は実行中に報告する内容から（サインイン情報は一切読みません）、Codex は自身のアプリサーバーから、Copilot はあなたの GitHub CLI を通じて取得します。Cursor はコンピューター上に何も保存しないため、Friday は Cursor 自身の CLI と同じリクエストを、Cursor のサーバーにだけ送ります。サインイン情報をコンピューター上に保存するそのほかのツール（Kilo、OpenCode、Grok、Factory Droid、Antigravity、Cline、Amp など）については、そのツール自身のサーバーに残り使用量を問い合わせるためだけに、Friday がその場で読み取ります。ほかの場所には送らず、私たちにも送らず、利用カウントにも含めません。Friday がツールのサインイン中のアカウントを切り替えることはありません。Settings › Your models で追加したモデルはあなたのコンピューターから呼び出され、そのキーもコンピューター上に保存され、そのモデル自身のサーバーにだけ送られます。デスクトップアプリは開いている間、GitHub に新しいリリースがないかも確認します（起動時、アプリに戻ったとき、10 分ごと）。見つかればそこからダウンロードし、再起動時にインストールします（`FRIDAY_NO_UPDATE_CHECK=1` でオフにできます）。

</details>

<details>
<summary><b>よくある質問</b></summary>

**1 つのプロジェクトで Claude Code と Codex を同時に動かすには？**
リポジトリでどちらかを使ってセッションを始め、もう一方をセッションのエージェントバーから追加します。それぞれがリポジトリの専用コピー（Git worktree）で作業できるので互いに上書きせず、Friday が両者の会話をつなぎます。

**自分でコードを書いて使うマルチエージェントフレームワークですか？**
いいえ。Friday は、普段使っているコーディング CLI をそのまま動かします。書くものは何もありません。ツールを選んで仕事を渡すだけです。

**エージェント 1 つから始められますか？**
はい。コーディングツール 1 つのセッションは、そのツールに Friday のレビュー、Git、プレビューが加わったものとして動きます。仕事を分けたくなったら、いつでも 2 つ目のエージェントを追加できます。

**既存のリポジトリで使えますか？**
はい。コンピューター上のどのフォルダーやリポジトリでもセッションに指定できます。追加したエージェントはそれぞれ専用の Git worktree で作業でき、コミットしていない作業があるフォルダーを Friday が勝手に切り替えることはありません。

**アカウント、サーバー、新しいサブスクリプションは必要ですか？**
いいえ。Friday はアカウントなしで、あなたのコンピューターの `127.0.0.1` で動きます。作業は、すでにサインインしているコーディングツールで行われます。

**コーディングツールがインストールされていない場合は？**
Friday は見つかったツールだけを使います。セットアップ画面に、どれがインストール済みでサインイン済みかが表示され、残りのサインインも代わりに行えます。

**どのコーディングエージェントに対応していますか？**
Claude Code、Codex、Cursor、GitHub Copilot、Gemini CLI、Antigravity CLI、OpenCode、Devin CLI、Junie、Kiro、Factory Droid、Grok Build、Cline、Kilo Code、Amp、Muse Code、そして Agent Client Protocol (ACP) を話す任意のエージェントです。

**費用はかかりますか？ API キーを使いますか？**
Friday は無料で、MIT ライセンスです。作業は各ツール自身のプランとサインインで動くので、貼り付けるキーも追加の支払いもありません。Friday 独自のエージェントである Friday Code も使いたい場合は、Settings › Your models であなたのキーかコンピューター上のモデルを指定してください。Friday Code はそれで動きます。

**エージェントの使用量が尽きたらどうなりますか？**
そのタスクは、仕上げるのに最も適したエージェントに渡ります。最初のエージェントがやったことと変更した内容の記録も一緒に渡るので、作業は止まりません。

**自分がいない間もエージェントを動かせますか？**
はい。Automation が、スケジュール、webhook、または別のセッションの終了をきっかけにコーディングツールを起動し、あなたがレビューするプルリクエストを作ります。起動するには Friday が動いている必要があります。コンピューターがオフの間に逃した実行を、復帰時に行うかどうかは選べます。

**コードがコンピューターの外に出ますか？**
Friday 経由では出ません。Friday はアカウントなしで `127.0.0.1` で動きます。コーディングツールはいつもどおり、それぞれのプロバイダーと通信します。Friday が私たちに送るのは[プライバシー](#privacy)に書いた匿名の利用カウントだけで、コードは含まれず、オフにもできます。
</details>

<a id="contributing"></a>
## コントリビュート

Friday はオープンに開発されていて、すべてのプルリクエストに 1 日以内に返信します。始めるのにおすすめの場所：

- **コーディングツールを追加する。** ほとんどのツールは短いアダプターで済みます。[goose](https://github.com/splashxmoon/friday-code/issues/36)、[Auggie](https://github.com/splashxmoon/friday-code/issues/37)、[Aider](https://github.com/splashxmoon/friday-code/issues/38)、[Crush](https://github.com/splashxmoon/friday-code/issues/39) が担当者を待っていて、[ガイド](../../docs/adding-a-coding-tool.md)で 1 つ追加する流れを説明しています。
- **パッケージにする。** Windows 向けの [Scoop](https://github.com/splashxmoon/friday-code/issues/41)、Arch 向けの [AUR](https://github.com/splashxmoon/friday-code/issues/40)。
- **試して報告する。** [お使いのディストリビューションでの Linux AppImage](https://github.com/splashxmoon/friday-code/issues/4)、[Windows と Linux での MCP サインイン](https://github.com/splashxmoon/friday-code/issues/26)。
- **ほかには？** [こちらから](https://github.com/splashxmoon/friday-code/issues/42)、[good first issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue)、または [Discussions](https://github.com/splashxmoon/friday-code/discussions) でアイデアを。

ビルドするには：`npm install`、`npm start`（または `npm run desktop`）、`npm test`。残りは [CONTRIBUTING.md](../../CONTRIBUTING.md) にあります。リリースノートでは毎回、その作業に関わった人たちに感謝を伝えています。

Friday の開発を手伝ってくれたすべての人に感謝します：

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Friday のコントリビューター" /></a>

Friday で時間が浮いたら、⭐ をもらえるとほかの開発者が見つけやすくなります。

## ライセンス

[MIT](../../LICENSE)
