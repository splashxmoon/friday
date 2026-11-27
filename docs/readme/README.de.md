<p align="center">
  <img src="../../docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Eine App für alle deine Coding-Agents.</strong><br/>
  Claude Code, Codex, Cursor und 19 weitere, mit den Abos, die du schon bezahlst. Lass sie nebeneinander laufen oder gib ihnen eine Aufgabe: Sie teilen sie auf, prüfen gegenseitig ihre Arbeit und springen ein, wenn einem das Kontingent ausgeht. Kostenlos und Open Source, auf deinem eigenen Rechner.
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.fr.md">Français</a> · <b>Deutsch</b> · <a href="README.ru.md">Русский</a></sub></p>
<p align="center"><sub>Aus dem englischen README übersetzt. Bei Abweichungen ist die englische Fassung die aktuelle.</sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="GitHub-Sterne" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Lizenz: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS, Windows und Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac (Apple silicon)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac (Intel)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>oder, mit Node.js 22: <code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>Wenn dir Friday Zeit spart, hilft ein ⭐ anderen, es zu finden. Lust, mitzubauen? <a href="#contributing">Hier geht's los</a>.</sub></p>

<p align="center">
  <img src="../../docs/assets/site/hero.png" alt="Friday an einem Beispielprojekt für einen Onlineshop: der Thread checkout-v2 mit einem Dreierteam, Amp und Claude Code 2 arbeiten, während Codex beantwortet, ob 3-D Secure durch einen Test abgedeckt ist, und das Agents-Panel zeigt, wer fertig ist und wer noch arbeitet" width="960" />
</p>

Stell es dir als Gruppenchat und Aufgabenboard für deine KI-Coding-Agents vor.

- **Sie reden miteinander.** Agents schreiben sich während der Arbeit Nachrichten: ein Hinweis auf eine Umbenennung, eine Frage, die Antwort. Du siehst jede Nachricht.
- **Sie teilen die Arbeit auf.** Ein Agent macht aus der Aufgabe ein gemeinsames Aufgabenboard. Die anderen nehmen sich die Teile, die zu ihnen passen, jeder in seiner eigenen Kopie deines Repos, damit keiner die Arbeit eines anderen überschreibt.
- **Sie prüfen sich gegenseitig.** Eine fertige Aufgabe wird von einem anderen Agent geprüft (von einem anderen Modell, wenn eins frei ist). Dann liest du den Diff, hinterlässt Notizen an beliebigen Zeilen und committest.

Und wenn einem Agent das Kontingent ausgeht, übernimmt ein anderer seine Aufgabe, mit einer Aufzeichnung dessen, was schon erledigt wurde.

<table>
<tr>
<td width="50%"><img src="../../docs/assets/site/talk.png" alt="Claude Code fragt Codex, ob der 3-D-Secure-Pfad in checkout-v2 durch einen Test abgedeckt ist, und die Antwort von Codex kommt im Chat zurück" /></td>
<td width="50%"><img src="../../docs/assets/site/board.png" alt="Team-Aufgaben: Cursor und Kilo arbeiten am Gast-Checkout und am Warten auf 3-D Secure, vier weitere folgen, jede wartet auf die vorherige" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Sie reden miteinander.</b> Ein Agent fragt einen anderen, was er gefunden hat, und bekommt die Antwort im Chat.</sub></td>
<td width="50%" valign="top"><sub><b>Sie teilen die Arbeit auf.</b> Jede Aufgabe, wer sie hat und wie weit sie ist, auf einem Board.</sub></td>
</tr>
<tr>
<td width="50%"><img src="../../docs/assets/site/review.png" alt="Friday IDE: ein Selbst-Review von checkout.ts mit dem behobenen Bug als Notiz in Zeile 12 und der Review-Karte: drei behoben, einer für dich" /></td>
<td width="50%"><img src="../../docs/assets/site/own-copy.png" alt="Kilo wird dem Shop-Repo hinzugefügt, auf einem eigenen Worktree und Branch" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Sie prüfen sich gegenseitig.</b> Ein Agent reviewt die Änderung und hinterlässt seine Befunde an den Zeilen, bevor du sie liest.</sub></td>
<td width="50%" valign="top"><sub><b>Jeder in seiner eigenen Kopie.</b> Jeder Agent bekommt einen eigenen Worktree und Branch, damit keiner die Arbeit eines anderen überschreibt.</sub></td>
</tr>
</table>

### Friday IDE

Dein Editor, dein Terminal und deine Extensions, mit dem Chat jedes Agents direkt daneben. Bearbeite direkt mit ⌘K, lass zwei oder drei Coding-Tools um dieselbe Anfrage antreten und behalte das beste Ergebnis, und hol dir ein Selbst-Review vor dem Pull Request.

<p align="center">
  <img src="../../docs/assets/site/ide.png" alt="Friday IDE: checkout.ts im Editor geöffnet, daneben im Chat drei Coding-Tools, die um dieselbe Anfrage antreten, jedes mit Compare und Keep" width="960" />
</p>

## In fünf Minuten startklar

1. **Melde dich bei einem Coding-Tool an**, das du schon nutzt, zum Beispiel mit `claude auth login` oder `codex login`.
2. **Installiere Friday** über einen der Download-Links oben, oder führe `npx github:splashxmoon/friday-code` mit Node.js 22 aus.
3. **Öffne es.** Friday listet die Coding-Tools auf, die es auf deinem Rechner gefunden hat.
4. **Starte eine Session** in deinem Repo und gib ihr eine Aufgabe.
5. **Prüfe die Änderungen** und behalte, was dir gefällt.

Ein Agent reicht für den Anfang. Nimm einen zweiten dazu, wenn sie sich die Arbeit teilen sollen.

## Funktioniert mit den Agents, für die du schon zahlst

Keine API-Keys und kein neues Abo: Friday steuert die Coding-Tools, die auf deinem Rechner angemeldet sind.

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
    <td align="center" width="120"><img src="../../docs/assets/tools/goose.svg" width="32" height="32" alt="" /><br /><sub>Goose</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/auggie.svg" width="32" height="32" alt="" /><br /><sub>Auggie</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/aider.svg" width="32" height="32" alt="" /><br /><sub>Aider</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/crush.svg" width="32" height="32" alt="" /><br /><sub>Crush</sub></td>
    <td align="center" width="120"><img src="../../docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>Jeder ACP-Agent</sub></td>
  </tr>
</table>

## Kostenlos, und auf deinem Rechner

Friday steht unter der MIT-Lizenz, hat kein Konto und kein eigenes Modell und lauscht nur auf `127.0.0.1`. Dein Code, deine Prompts und deine Dateien landen nie bei uns. Das Einzige, was es sendet, sind ein paar anonyme Nutzungszahlen, die du abschalten kannst ([was genau](#privacy)). Was wir verkaufen, ist [Friday Team](https://www.tryfridaywork.com), die gehostete Version für mehrere Personen in einer Session.

## Mehr

<details>
<summary><b>Crew: KI-Teammitglieder mit Gedächtnis</b></summary>

Halte KI-Teammitglieder auf deinem Rechner, jedes mit Namen, Rolle, Gedächtnis und eigenem Ordner, auf einem deiner Coding-Tools. Gib der Crew ein Ziel und die Leitung plant es auf einem Board, oder sprich eines davon mit `@` an. Dazu gibt es Räume mit Neben-Threads, Rechte pro Teammitglied (Read only, Ask before changes, Full access) und Away bis zu einer bestimmten Uhrzeit (die Teammitglieder notieren ihre Annahmen und eine Zusammenfassung wartet auf dich; das funktioniert, solange dein Rechner an bleibt und Friday läuft). Außerdem ein Ersatz-Tool, wenn einem das Kontingent ausgeht, und Workflows, die als Schritte gezeichnet sind.

<img src="../../docs/assets/site/crew-room.png" alt="Ein Crew-Raum: Kit baut die Preisseite und meldet sich in einer Karte bei Nova zurück, und Nova fasst zusammen" width="960" />
</details>

<details>
<summary><b>Regeln, Projektgedächtnis und Sicherheit</b></summary>

- **Regeln, die bleiben:** Sag einem Agent einmal „fass niemals die Migrationen an“, und Friday bietet es als Regel an, an der die spätere Arbeit jedes Agents geprüft wird.
- **War es schon kaputt?** Ein fehlschlagender Test wird auf dem Code von vor dem Start des Agents erneut ausgeführt, damit alte Fehler als alt markiert werden.
- **Projektgedächtnis:** Korrekturen werden pro Repo gespeichert, und jeder Agent, der dort startet, erfährt sie zuerst.
- **Standardmäßig vorsichtig:** Vor einem Befehl, der löscht, deployt, veröffentlicht oder installiert, ist Don't der Hauptbutton. Secrets (API-Keys, Tokens, Webhook-URLs) werden im Chat und im Git-Panel verborgen.
</details>

<details>
<summary><b>Automationen, Git und alles andere</b></summary>

- **Automationen:** nach Zeitplan, per Webhook oder wenn eine andere Session fertig ist; ein Tool oder mehrere, die sich die Arbeit teilen; am Ende steht ein Pull Request, den du prüfst.
- **Git eingebaut:** Hunks stagen, committen, pushen, einen PR öffnen.
- **Friday Code:** Fridays eigener Agent, mit einem deiner API-Keys oder einem lokalen Modell (Ollama, LM Studio).
- **Andere Agents Friday nutzen lassen:** Claude Code, Codex oder jeder MCP-Client auf deinem Rechner kann Friday-Sessions starten und ihnen Arbeit übergeben (`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`).
- Live-Feed, Zurückspulen, Vorschau des Dev-Servers, Terminal, ⌘K für alles, Themes, Benachrichtigungen.
</details>

<details>
<summary><b>Installationsdetails: Installation und Anmeldung für jedes Tool, Homebrew, Einstellungen</b></summary>

### Unterstützte Tools und Installation

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| Tools | Installation | Anmeldung |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | `gemini` einmal starten und anmelden |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `agy` einmal starten und anmelden |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | Anmeldung auf dem eigenen Startbildschirm |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | Anmeldung auf dem eigenen Startbildschirm |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | `qwen` einmal starten und anmelden |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | `pi` einmal starten und `/login` eingeben (oder den API-Key eines Anbieters setzen) |
| **Goose** | **Windows** `irm https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \| bash` | `goose configure` starten und einen Anbieter wählen |
| **Auggie** | `npm install -g @augmentcode/auggie` | `auggie auth login` |
| **Aider** | **Windows** `powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 \| iex"` <br> **Mac/Linux** `curl -LsSf https://aider.chat/install.sh \| sh` | den API-Key eines Anbieters setzen (z. B. `ANTHROPIC_API_KEY`) |
| **Crush** | `npm install -g @charmland/crush` | `crush login` (oder der API-Key eines Anbieters) |
| **Anderer ACP-Agent** | je nach ACP-Agent | je nach ACP-Agent |

### Die Desktop-App

| | |
| --- | --- |
| Mac, Apple silicon | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac, Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage) (mit `chmod +x` ausführbar machen, dann starten) |

Auf dem Mac geht es auch mit Homebrew:

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

Alle Versionen findest du auf der [Releases-Seite](https://github.com/splashxmoon/friday-code/releases). Die App ist Friday in einem eigenen Fenster, mit demselben Server darin, nur auf `127.0.0.1`.

Die Mac-App ist von Apple signiert und notarisiert, sie öffnet sich also wie jede andere.

> [!NOTE]
> Der Windows-Installer ist noch nicht signiert, deshalb fragt Windows beim ersten Start nach: Wähle **Weitere Informationen** und dann **Trotzdem ausführen**.

### Aus dem Terminal

Mit Node.js 22 oder neuer und Git:

```bash
npx github:splashxmoon/friday-code
```

Friday öffnet sich in deinem Browser unter `http://127.0.0.1:4321`. Für eine eigene Kopie:

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| Einstellung | Standard | Wirkung |
| --- | --- | --- |
| `PORT` | `4321` | Wo Friday lauscht, nur auf diesem Rechner. |
| `FRIDAY_HOME` | `~/.friday` | Wo es deine Sessions und Einstellungen speichert. |
| `--no-open` | | Starten, ohne den Browser zu öffnen. |
</details>

<details>
<summary id="privacy"><b>Datenschutz: genau das, was gesendet wird</b></summary>

Friday lauscht nur auf `127.0.0.1`, sodass nichts anderes in deinem Netzwerk es erreichen kann, und es antwortet nur seiner eigenen Seite: Eine Anfrage von einer anderen Website oder von einer Seite in der Vorschau wird abgelehnt. Was es speichert, liegt in einem einzigen Ordner auf deinem Rechner, den nur du lesen kannst.

Es hat kein Konto, und dein Code, deine Prompts und deine Dateien landen nie bei uns. Was es sendet, sind ein paar anonyme Nutzungszahlen, damit wir sehen, ob Leute Friday zum Laufen bringen und weiter nutzen. Jede davon geht per HTTPS an [PostHog](https://posthog.com), mit abgeschalteter IP-basierter Standortbestimmung und abgeschalteten Personenprofilen; eine fehlgeschlagene Übertragung wird verworfen. Der gesamte Code steht in [`src/usage.ts`](../../src/usage.ts).

- Eine zufällige ID, die auf deinem Rechner für diese Installation erzeugt wird und mit nichts anderem verknüpft ist.
- Fridays Version, dein System (macOS, Windows oder Linux) und dessen Architektur, und ob es die Desktop-App ist.
- Einmal an jedem Tag, an dem du es öffnest: dass du es geöffnet hast, die Namen der gefundenen Coding-Tools und wie viele davon angemeldet sind.
- Jede gestartete Session, und ob es eine Code- oder Crew-Session ist.
- Jeweils einmal: das erste Mal, dass ein Coding-Tool bereit ist, und das erste Mal, dass ein Agent einen Turn beendet.

Niemals: Prompts, Code, Dateinamen oder Pfade, Repository-Namen, E-Mail-Adressen, Konten oder Anmeldungen, oder irgendetwas, das ein Tool schreibt. Friday fragt beim ersten Öffnen in seinem Willkommensbildschirm nach den Nutzungszahlen (oder in einem Hinweis in der Seitenleiste, wenn du die Begrüßung überspringst) und sendet nichts, bevor du antwortest. Abschalten kannst du sie unter Settings › Data & backup › Share anonymous usage, oder indem du `FRIDAY_NO_TELEMETRY=1` oder `DO_NOT_TRACK=1` dort setzt, wo Friday läuft.

Es spricht mit GitHub für die Pull Requests, Issues und Skills, nach denen du fragst. Das verbleibende Kontingent jedes Tools kommt, wo immer möglich, vom Tool selbst: bei Claude Code aus dem, was es während der Ausführung meldet (seine Anmeldung wird nie gelesen), bei Codex von dessen eigenem App-Server, bei Copilot über deine GitHub CLI. Cursor speichert nichts auf deinem Rechner, deshalb stellt Friday dieselbe Anfrage wie Cursors eigene CLI, an Cursors Server und nirgendwo sonst hin. Bei den anderen Tools, die eine Anmeldung auf deinem Rechner speichern (Kilo, OpenCode, Grok, Factory Droid, Antigravity, Cline, Amp und ein paar weitere), liest Friday sie dort nur, um den eigenen Server dieses Tools zu fragen, wie viel Kontingent du noch hast. Sie geht nirgendwo sonst hin, nie zu uns und nie in die Nutzungszahlen. Friday wechselt nie das Konto, mit dem ein Tool angemeldet ist. Ein Modell, das du unter Settings › Your models hinzufügst, wird von deinem Rechner aus aufgerufen, und sein Key bleibt dort und wird nur an den eigenen Server dieses Modells gesendet. Die Desktop-App fragt außerdem bei GitHub nach einer neueren Version, solange sie offen ist (beim Start, wenn du zu ihr zurückkehrst, und alle zehn Minuten), lädt sie von dort herunter und installiert sie beim Neustart (`FRIDAY_NO_UPDATE_CHECK=1` schaltet das ab).

</details>

<details>
<summary><b>FAQ</b></summary>

**Wie lasse ich Claude Code und Codex gleichzeitig in einem Projekt laufen?**
Starte mit einem der beiden eine Session in deinem Repository und füge den anderen über die Agent-Leiste der Session hinzu. Jeder kann in seiner eigenen Kopie des Repositorys arbeiten (einem Git-Worktree), damit sie sich nicht gegenseitig überschreiben, und Friday sorgt dafür, dass sie miteinander reden.

**Ist das ein Multi-Agent-Framework, gegen das ich programmieren muss?**
Nein. Friday steuert die Coding-CLIs, die du schon nutzt, so wie sie sind. Es gibt nichts zu schreiben: Du wählst die Tools aus und gibst ihnen die Aufgabe.

**Kann ich mit nur einem Agent anfangen?**
Ja. Eine Session mit einem Coding-Tool funktioniert wie dieses Tool, ergänzt um Fridays Review, Git und Vorschau. Nimm einen zweiten Agent dazu, wann immer sie sich die Arbeit teilen sollen.

**Funktioniert es mit meinem bestehenden Repo?**
Ja. Richte eine Session auf einen beliebigen Ordner oder ein Repository auf deinem Rechner. Hinzugefügte Agents können jeweils in einem eigenen Git-Worktree davon arbeiten, und Friday wechselt einen Ordner mit nicht committeter Arbeit nicht einfach unter dir weg.

**Brauche ich ein Konto, einen Server oder ein neues Abo?**
Nein. Friday läuft auf deinem Rechner unter `127.0.0.1`, ohne Konto, und die Arbeit läuft über die Coding-Tools, bei denen du schon angemeldet bist.

**Was, wenn ein Coding-Tool nicht installiert ist?**
Friday nutzt nur die Tools, die es findet. Sein Einrichtungsbildschirm zeigt, welche installiert und angemeldet sind, und kann die übrigen für dich anmelden.

**Welche Coding-Agents werden unterstützt?**
Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity CLI, OpenCode, Devin CLI, Junie, Kiro, Factory Droid, Grok Build, Cline, Kilo Code, Amp, Muse Code und jeder Agent, der das Agent Client Protocol (ACP) spricht.

**Kostet es etwas, oder nutzt es meine API-Keys?**
Friday ist kostenlos und steht unter der MIT-Lizenz. Die Arbeit läuft über das Abo und die Anmeldung jedes Tools, es gibt also keine Keys einzufügen und nichts extra zu bezahlen. Wenn du auch Friday Code möchtest, Fridays eigenen Agent, gib ihm unter Settings › Your models einen deiner Keys oder ein Modell auf deinem Rechner: Dann läuft er damit.

**Was passiert, wenn einem Agent das Kontingent ausgeht?**
Seine Aufgabe geht an den Agent, der sie am besten zu Ende bringen kann, mit einer Aufzeichnung dessen, was der erste getan und geändert hat, damit die Arbeit weitergeht.

**Kann es meine Agents laufen lassen, während ich nicht da bin?**
Ja: Eine Automation startet ein Coding-Tool nach Zeitplan, per Webhook oder wenn eine andere Session fertig ist, und öffnet einen Pull Request, den du prüfst. Friday muss laufen, damit sie startet; du legst fest, ob ein Lauf, der verpasst wurde, während der Rechner aus war, nachgeholt wird, wenn er wieder an ist.

**Verlässt mein Code meinen Rechner?**
Nicht über Friday. Es läuft auf `127.0.0.1` ohne Konto; deine Coding-Tools sprechen wie immer mit ihren eigenen Anbietern. Das Einzige, was Friday an uns sendet, sind die anonymen Nutzungszahlen unter [Datenschutz](#privacy), die nie Code enthalten, und du kannst sie abschalten.
</details>

<a id="contributing"></a>
## Mitmachen

Friday wird offen entwickelt, und jeder Pull Request bekommt innerhalb eines Tages eine Antwort. Gute Einstiegspunkte:

- **Ein Coding-Tool hinzufügen.** Die meisten Tools brauchen nur einen kurzen Adapter, und [die Anleitung](../../docs/adding-a-coding-tool.md) geht einen Schritt für Schritt durch.
- **Es paketieren.** [Scoop](https://github.com/splashxmoon/friday-code/issues/41) für Windows, [das AUR](https://github.com/splashxmoon/friday-code/issues/40) für Arch.
- **Ausprobieren und berichten.** [Das Linux-AppImage auf deiner Distribution](https://github.com/splashxmoon/friday-code/issues/4), [MCP-Anmeldung unter Windows und Linux](https://github.com/splashxmoon/friday-code/issues/26).
- **Etwas anderes?** [Hier geht's los](https://github.com/splashxmoon/friday-code/issues/42), die [Good First Issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue), oder eine Idee in den [Discussions](https://github.com/splashxmoon/friday-code/discussions).

Zum Bauen: `npm install`, `npm start` (oder `npm run desktop`), `npm test`. Den Rest findest du in [CONTRIBUTING.md](../../CONTRIBUTING.md). Jede Release-Note dankt den Leuten, deren Arbeit darin steckt.

Danke an alle, die beim Bau von Friday geholfen haben:

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Fridays Mitwirkende" /></a>

Wenn dir Friday Zeit spart, hilft ein ⭐ anderen Entwicklerinnen und Entwicklern, es zu finden.

## Lizenz

[MIT](../../LICENSE)
