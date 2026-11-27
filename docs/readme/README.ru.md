<p align="center">
  <img src="../../docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Одно приложение для всех ваших агентов для кода.</strong><br/>
  Claude Code, Codex, Cursor и ещё 19 инструментов, на подписках, за которые вы уже платите. Запускайте их рядом или дайте им задачу: они делят её между собой, проверяют работу друг друга и подхватывают, когда у одного заканчиваются лимиты. Бесплатно, с открытым кодом, на вашем компьютере.
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <b>Русский</b></sub></p>

<p align="center"><sub>Это перевод английского README. Если они расходятся, актуальна английская версия.</sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="Звёзды на GitHub" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Лицензия: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS, Windows и Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac (Apple silicon)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac (Intel)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>или, с Node.js 22: <code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>Если Friday экономит вам время, ⭐ поможет другим его найти. Хотите помочь в разработке? <a href="#contributing">Начните здесь</a>.</sub></p>

<p align="center">
  <img src="../../docs/assets/site/hero.png" alt="Friday на демо-проекте интернет-магазина: тред checkout-v2 с командой из трёх агентов, Amp и Claude Code 2 работают, а Codex отвечает, покрыт ли 3-D Secure тестом; панель Agents показывает, кто закончил и кто работает" width="960" />
</p>

Представьте групповой чат и доску задач для ваших AI-агентов для кода.

- **Они общаются.** Агенты пишут друг другу по ходу работы: предупреждение о переименовании, вопрос, ответ. Вы видите каждое сообщение.
- **Они делят работу.** Один агент превращает задачу в общую доску задач; остальные берут подходящие им части, каждый в своей копии репозитория, так что никто ничего не перезаписывает.
- **Они проверяют друг друга.** Готовую задачу проверяет другой агент (на другой модели, если такой свободен), затем вы читаете diff, оставляете заметки на любой строке и делаете commit.

А когда у одного агента заканчиваются лимиты, другой подхватывает его задачу вместе с записью о том, что уже сделано.

<table>
<tr>
<td width="50%"><img src="../../docs/assets/site/talk.png" alt="Claude Code спрашивает Codex, покрыт ли тестом путь 3-D Secure в checkout-v2, и ответ Codex приходит в чат" /></td>
<td width="50%"><img src="../../docs/assets/site/board.png" alt="Задачи команды: Cursor и Kilo работают над гостевым оформлением заказа и ожиданием 3-D Secure, ещё четыре задачи на очереди, каждая ждёт предыдущую" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Они общаются.</b> Один агент спрашивает другого, что тот нашёл, и получает ответ прямо в чате.</sub></td>
<td width="50%" valign="top"><sub><b>Они делят работу.</b> Все задачи, кто за что взялся и на каком всё этапе, на одной доске.</sub></td>
</tr>
<tr>
<td width="50%"><img src="../../docs/assets/site/review.png" alt="Friday IDE: самопроверка checkout.ts, исправленный баг в виде заметки на строке 12 и карточка ревью: три исправлено, одно для вас" /></td>
<td width="50%"><img src="../../docs/assets/site/own-copy.png" alt="Kilo добавляется в репозиторий storefront в собственном worktree и ветке" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Они проверяют друг друга.</b> Агент делает ревью изменения и оставляет замечания прямо на строках до того, как вы его прочтёте.</sub></td>
<td width="50%" valign="top"><sub><b>У каждого своя копия.</b> Каждый агент получает свой worktree и ветку, так что никто ничего не перезаписывает.</sub></td>
</tr>
</table>

### Friday IDE

Ваш редактор, терминал и расширения, а рядом чат каждого агента. Правьте на месте через ⌘K, устраивайте гонку двух или трёх инструментов на одном запросе и оставляйте лучший результат, получайте самопроверку перед pull request.

<p align="center">
  <img src="../../docs/assets/site/ide.png" alt="Friday IDE: checkout.ts открыт в редакторе, а в чате рядом три инструмента соревнуются на одном запросе, у каждого кнопки Compare и Keep" width="960" />
</p>

## Начало работы за пять минут

1. **Войдите в один инструмент для кода**, которым уже пользуетесь, например `claude auth login` или `codex login`.
2. **Установите Friday** по ссылке для скачивания выше или запустите `npx github:splashxmoon/friday-code` с Node.js 22.
3. **Откройте его.** Friday покажет инструменты для кода, которые нашёл на вашем компьютере.
4. **Начните сессию** в своём репозитории и дайте ей задачу.
5. **Посмотрите, что изменилось**, и оставьте то, что нравится.

Для начала хватит одного агента. Добавьте второго, когда захотите, чтобы они делили работу.

## Работает с агентами, за которых вы уже платите

Без API-ключей и без нового тарифа: Friday управляет инструментами для кода, в которые вы уже вошли на своём компьютере.

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
    <td align="center" width="120"><img src="../../docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>Любой ACP-агент</sub></td>
  </tr>
</table>

## Бесплатно и на вашем компьютере

Friday распространяется по лицензии MIT, не требует аккаунта, не имеет своей модели и слушает только `127.0.0.1`. Ваш код, промпты и файлы никогда не попадают к нам. Единственное, что он отправляет, это несколько анонимных счётчиков использования, и их можно отключить ([что именно](#privacy)). Продаём мы [Friday Team](https://www.tryfridaywork.com), облачную версию для нескольких человек в одной сессии.

## Подробнее

<details>
<summary><b>Crew: AI-коллеги с памятью</b></summary>

Держите AI-коллег на своём компьютере, у каждого имя, роль, память и своя папка, на одном из ваших инструментов для кода. Дайте команде цель, и ведущий распланирует её на доске, или упомяните через `@` кого-то одного. Комнаты с побочными тредами, доступ для каждого коллеги (Read only, Ask before changes, Full access), режим Away до заданного времени (коллеги записывают свои допущения, а вас ждёт сводка; это работает, пока компьютер включён и Friday запущен), запасной инструмент на случай, когда у одного кончаются лимиты, и рабочие процессы, нарисованные по шагам.

<img src="../../docs/assets/site/crew-room.png" alt="Комната команды: Kit делает страницу с ценами и отчитывается Nova одной карточкой, а Nova подводит итог" width="960" />
</details>

<details>
<summary><b>Правила, память проекта и безопасность</b></summary>

- **Правила, которые запоминаются:** скажите агенту "never touch the migrations" один раз, и Friday предложит сделать это правилом, по которому проверяется вся дальнейшая работа каждого агента.
- **А не было ли это сломано раньше?** Упавший тест перезапускается на коде до начала работы агента, так что старые падения помечаются как старые.
- **Память проекта:** исправления хранятся для каждого репозитория, и каждый агент, начинающий там работу, сначала узнаёт о них.
- **Осторожность по умолчанию:** перед командой, которая удаляет, деплоит, публикует или устанавливает, главная кнопка это Don't. Секреты (API-ключи, токены, URL вебхуков) скрываются в чате и на панели Git.
</details>

<details>
<summary><b>Автоматизации, Git и всё остальное</b></summary>

- **Автоматизации:** по расписанию, по вебхуку или когда завершается другая сессия; один инструмент или несколько, делящих работу; в конце pull request, который вы проверяете.
- **Встроенный Git:** stage по фрагментам (hunk), commit, push, открытие PR.
- **Friday Code:** собственный агент Friday, на вашем API-ключе или локальной модели (Ollama, LM Studio).
- **Пусть другие агенты пользуются Friday:** Claude Code, Codex или любой MCP-клиент на вашем компьютере могут запускать сессии Friday и передавать им работу (`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`).
- Живая лента, перемотка назад, превью dev-сервера, терминал, ⌘K для всего, темы, уведомления.
</details>

<details>
<summary><b>Подробности установки: установка и вход для каждого инструмента, Homebrew, настройки</b></summary>

### Поддерживаемые инструменты и установка

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| Инструменты | Установка | Вход |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | запустите `gemini` один раз и войдите |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | запустите `agy` один раз и войдите |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | Вход на его собственном первом экране |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | Вход на его собственном первом экране |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | запустите `qwen` один раз и войдите |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | запустите `pi` один раз и введите `/login` (или задайте API-ключ провайдера) |
| **Goose** | **Windows** `irm https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \| bash` | запустите `goose configure` и выберите провайдера |
| **Auggie** | `npm install -g @augmentcode/auggie` | `auggie auth login` |
| **Aider** | **Windows** `powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 \| iex"` <br> **Mac/Linux** `curl -LsSf https://aider.chat/install.sh \| sh` | задайте API-ключ провайдера (например, `ANTHROPIC_API_KEY`) |
| **Crush** | `npm install -g @charmland/crush` | `crush login` (или API-ключ провайдера) |
| **Другой ACP-агент** | любой ACP-агент | любой ACP-агент |

### Десктопное приложение

| | |
| --- | --- |
| Mac, Apple silicon | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac, Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage) (выполните для файла `chmod +x`, затем запустите) |

На Mac его можно установить и через Homebrew:

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

Все версии есть на [странице релизов](https://github.com/splashxmoon/friday-code/releases). Приложение это Friday в отдельном окне, с тем же сервером внутри, только на `127.0.0.1`.

Приложение для Mac подписано и нотаризовано Apple, поэтому открывается как любое другое.

> [!NOTE]
> Установщик для Windows пока не подписан, поэтому при первом запуске Windows спросит подтверждение: выберите **More info**, затем **Run anyway**.

### Из терминала

С Node.js 22 или новее и Git:

```bash
npx github:splashxmoon/friday-code
```

Friday откроется в браузере по адресу `http://127.0.0.1:4321`. Чтобы сохранить копию:

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| Настройка | По умолчанию | Что делает |
| --- | --- | --- |
| `PORT` | `4321` | Где слушает Friday, только на этом компьютере. |
| `FRIDAY_HOME` | `~/.friday` | Где хранятся ваши сессии и настройки. |
| `--no-open` | | Запуск без открытия браузера. |
</details>

<details>
<summary id="privacy"><b>Приватность: что именно отправляется</b></summary>

Friday слушает только `127.0.0.1`, поэтому ничто другое в вашей сети до него не достучится, и он отвечает только своей собственной странице: запрос с любого другого сайта или со страницы в превью отклоняется. Всё, что он хранит, лежит в одной папке на вашем компьютере, доступной для чтения только вам.

У него нет аккаунта, и ваш код, промпты и файлы никогда не попадают к нам. Он отправляет только несколько анонимных счётчиков использования, чтобы мы видели, удаётся ли людям запустить Friday и продолжают ли они им пользоваться. Все они уходят в [PostHog](https://posthog.com) по HTTPS, с отключёнными геолокацией по IP и профилями пользователей; неудачная отправка просто отбрасывается. Весь код находится в [`src/usage.ts`](../../src/usage.ts).

- Случайный id, созданный на вашем компьютере для этой установки и ни с чем больше не связанный.
- Версия Friday, ваша система (macOS, Windows или Linux) и её архитектура, а также десктопное ли это приложение.
- Раз в день, когда вы его открываете: сам факт открытия, названия найденных инструментов для кода и сколько из них с выполненным входом.
- Каждая начатая сессия и её тип: Code или Crew.
- По одному разу: когда инструмент для кода впервые готов к работе и когда агент впервые завершает ход.

Никогда: промпты, код, имена файлов или пути, названия репозиториев, адреса email, аккаунты или данные входа, а также всё, что пишет инструмент. Friday спрашивает о счётчиках в приветствии при первом запуске (или в заметке на боковой панели, если вы пропустили приветствие) и ничего не отправляет, пока вы не ответите. Чтобы отключить их, откройте Settings › Data & backup › Share anonymous usage или задайте `FRIDAY_NO_TELEMETRY=1` либо `DO_NOT_TRACK=1` там, где запущен Friday.

Он обращается к GitHub за pull request'ами, issues и skills, о которых вы его спрашиваете. Оставшиеся лимиты каждого инструмента по возможности берутся у самого инструмента: для Claude Code из того, что он сообщает во время работы (данные его входа никогда не читаются), для Codex с его собственного app server, для Copilot через ваш GitHub CLI. Cursor ничего не хранит на вашем компьютере, поэтому Friday делает тот же запрос, что и собственный CLI Cursor, на сервер Cursor и никуда больше. Для других инструментов, которые хранят данные входа на вашем компьютере (Kilo, OpenCode, Grok, Factory Droid, Antigravity, Cline, Amp и ещё несколько), Friday читает их там только для того, чтобы спросить у собственного сервера этого инструмента, сколько лимитов у вас осталось. Они не уходят никуда больше, никогда к нам и никогда в счётчики использования. Friday никогда не переключает аккаунт, под которым инструмент выполнил вход. Модель, добавленная в Settings › Your models, вызывается с вашего компьютера, а её ключ хранится там же и отправляется только на сервер этой модели. Десктопное приложение также спрашивает у GitHub о новом релизе, пока оно открыто (при запуске, когда вы к нему возвращаетесь, и каждые десять минут), скачивает его оттуда и устанавливает при перезапуске (`FRIDAY_NO_UPDATE_CHECK=1` это отключает).

</details>

<details>
<summary><b>Частые вопросы</b></summary>

**Как запустить Claude Code и Codex одновременно на одном проекте?**
Начните сессию в своём репозитории с одним из них, затем добавьте другой через панель агентов сессии. Каждый может работать в своей копии репозитория (Git worktree), поэтому они не перезаписывают друг друга, а Friday поддерживает связь между ними.

**Это мультиагентный фреймворк, под который нужно писать код?**
Нет. Friday управляет CLI для кода, которыми вы уже пользуетесь, как они есть. Писать ничего не нужно: вы выбираете инструменты и даёте им задачу.

**Можно начать всего с одним агентом?**
Да. Сессия с одним инструментом работает как сам этот инструмент, плюс ревью, Git и превью от Friday вокруг него. Добавьте второго агента, когда захотите, чтобы они делили работу.

**Работает ли это с моим существующим репозиторием?**
Да. Укажите сессии любую папку или репозиторий на вашем компьютере. Каждый добавленный агент может работать в своём Git worktree этого репозитория, а Friday не переключит папку с незакоммиченной работой у вас из-под рук.

**Нужен ли аккаунт, сервер или новая подписка?**
Нет. Friday работает на вашем компьютере на `127.0.0.1`, без аккаунта, а работа выполняется в инструментах для кода, в которые вы уже вошли.

**Что, если инструмент для кода не установлен?**
Friday использует только те инструменты, которые находит. Экран настройки показывает, какие установлены и с выполненным входом, и может выполнить вход в остальные за вас.

**Какие агенты для кода поддерживаются?**
Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity CLI, OpenCode, Devin CLI, Junie, Kiro, Factory Droid, Grok Build, Cline, Kilo Code, Amp, Muse Code и любой агент, который поддерживает Agent Client Protocol (ACP).

**Это что-то стоит или использует мои API-ключи?**
Friday бесплатен и распространяется по лицензии MIT. Работа идёт на собственном тарифе и входе каждого инструмента, так что не нужно вставлять ключи и ничего доплачивать. Если хотите также Friday Code, собственного агента Friday, дайте ему свой ключ или модель на вашем компьютере в Settings › Your models: тогда он будет работать на них.

**Что происходит, когда у агента заканчиваются лимиты?**
Его задача переходит к агенту, который лучше всего подходит для её завершения, вместе с записью о том, что первый сделал и изменил, так что работа продолжается.

**Может ли он запускать моих агентов, пока меня нет?**
Да: автоматизация запускает инструмент для кода по расписанию, по вебхуку или когда завершается другая сессия, и открывает pull request на ваше ревью. Для запуска Friday должен быть запущен; вы сами решаете, выполнять ли запуск, пропущенный, пока компьютер был выключен, когда он снова включится.

**Покидает ли мой код мой компьютер?**
Не через Friday. Он работает на `127.0.0.1` без аккаунта; ваши инструменты для кода общаются со своими провайдерами, как и всегда. Единственное, что Friday отправляет нам, это анонимные счётчики использования из раздела [Приватность](#privacy), в которых никогда нет кода, и их можно отключить.
</details>

<a id="contributing"></a>
## Участие в разработке

Friday разрабатывается открыто, и на каждый pull request отвечают в течение дня. С чего можно начать:

- **Добавьте инструмент для кода.** Для большинства инструментов это короткий адаптер, а [руководство](../../docs/adding-a-coding-tool.md) проводит через один шаг за шагом.
- **Соберите пакет.** [Scoop](https://github.com/splashxmoon/friday-code/issues/41) для Windows, [AUR](https://github.com/splashxmoon/friday-code/issues/40) для Arch.
- **Попробуйте и расскажите.** [Linux AppImage на вашем дистрибутиве](https://github.com/splashxmoon/friday-code/issues/4), [вход в MCP на Windows и Linux](https://github.com/splashxmoon/friday-code/issues/26).
- **Что-то другое?** [Начните здесь](https://github.com/splashxmoon/friday-code/issues/42), с [good first issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue) или с идеи в [Discussions](https://github.com/splashxmoon/friday-code/discussions).

Чтобы собрать: `npm install`, `npm start` (или `npm run desktop`), `npm test`. Остальное в [CONTRIBUTING.md](../../CONTRIBUTING.md). В каждой заметке к релизу мы благодарим тех, чья работа в него вошла.

Спасибо всем, кто помогает создавать Friday:

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Участники разработки Friday" /></a>

Если Friday экономит вам время, ⭐ поможет другим разработчикам его найти.

## Лицензия

[MIT](../../LICENSE)
