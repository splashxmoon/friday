<p align="center">
  <img src="../../docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Um só app para todos os seus agentes de programação.</strong><br/>
  Claude Code, Codex, Cursor e mais 19, nas assinaturas que você já paga. Rode todos lado a lado ou passe um trabalho para eles: eles dividem as tarefas, revisam o trabalho uns dos outros e um assume quando outro fica sem uso. Gratuito e open source, no seu próprio computador.
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.es.md">Español</a> · <b>Português</b> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a></sub></p>

<p align="center"><sub>Traduzido do README em inglês. Se houver diferença, vale o em inglês.</sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="Estrelas no GitHub" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Licença: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS, Windows e Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac (Apple silicon)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac (Intel)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>ou, com Node.js 22: <code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>Se o Friday economiza seu tempo, uma ⭐ ajuda outras pessoas a encontrá-lo. Quer ajudar a construir? <a href="#contributing">Comece aqui</a>.</sub></p>

<p align="center">
  <img src="../../docs/assets/site/hero.png" alt="Friday em um projeto de loja de exemplo: a thread checkout-v2 com um time de três, Amp e Claude Code 2 trabalhando enquanto o Codex responde se o 3-D Secure está coberto por um teste, e o painel de agentes mostrando quem terminou e quem está trabalhando" width="960" />
</p>

Pense nele como um chat em grupo e um quadro de tarefas para os seus agentes de programação com IA.

- **Eles conversam.** Os agentes trocam mensagens enquanto trabalham: um aviso sobre uma renomeação, uma pergunta, a resposta. Você vê todas as mensagens.
- **Eles dividem o trabalho.** Um agente transforma o trabalho em um quadro de tarefas compartilhado; os outros pegam as partes que combinam com eles, cada um na sua própria cópia do seu repo, então ninguém sobrescreve ninguém.
- **Eles revisam uns aos outros.** Cada tarefa concluída é revisada por outro agente (um modelo diferente, quando houver um livre). Depois você lê o diff, deixa notas em qualquer linha e faz o commit.

E quando um agente fica sem uso, outro assume a tarefa dele com um registro do que já foi feito.

<table>
<tr>
<td width="50%"><img src="../../docs/assets/site/talk.png" alt="O Claude Code pergunta ao Codex se o fluxo de 3-D Secure no checkout-v2 está coberto por um teste, e a resposta do Codex chega no chat" /></td>
<td width="50%"><img src="../../docs/assets/site/board.png" alt="Tarefas do time: Cursor e Kilo trabalhando no checkout como convidado e na espera do 3-D Secure, mais quatro na fila, cada uma esperando a anterior" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Eles conversam.</b> Um agente pergunta a outro o que ele encontrou e recebe a resposta no chat.</sub></td>
<td width="50%" valign="top"><sub><b>Eles dividem o trabalho.</b> Cada tarefa, quem está com ela e em que pé está, em um só quadro.</sub></td>
</tr>
<tr>
<td width="50%"><img src="../../docs/assets/site/review.png" alt="Friday IDE: uma autorrevisão do checkout.ts com o bug corrigido como nota na linha 12 e o card de revisão: três corrigidos, um para você" /></td>
<td width="50%"><img src="../../docs/assets/site/own-copy.png" alt="Adicionando o Kilo ao repo da loja na sua própria worktree e branch" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Eles revisam uns aos outros.</b> Um agente revisa a mudança e deixa o que encontrou nas linhas antes de você ler.</sub></td>
<td width="50%" valign="top"><sub><b>Cada um na sua cópia.</b> Cada agente ganha a própria worktree e branch, então ninguém sobrescreve ninguém.</sub></td>
</tr>
</table>

### Friday IDE

Seu editor, seu terminal e suas extensões, com o chat de cada agente ao lado. Edite no lugar com ⌘K, coloque duas ou três ferramentas de programação para disputar o mesmo pedido e fique com a melhor, e receba uma autorrevisão antes do pull request.

<p align="center">
  <img src="../../docs/assets/site/ide.png" alt="Friday IDE: checkout.ts aberto no editor e três ferramentas de programação disputando o mesmo pedido no chat ao lado, cada uma com Compare e Keep" width="960" />
</p>

## Comece em cinco minutos

1. **Faça login em uma ferramenta de programação** que você já usa, por exemplo `claude auth login` ou `codex login`.
2. **Instale o Friday** com um dos links de download acima, ou rode `npx github:splashxmoon/friday-code` com Node.js 22.
3. **Abra.** O Friday lista as ferramentas de programação que encontrou no seu computador.
4. **Inicie uma sessão** no seu repo e passe um trabalho.
5. **Revise o que mudou** e fique com o que gostar.

Um agente basta para começar. Adicione um segundo quando quiser que eles dividam o trabalho.

## Funciona com os agentes que você já paga

Sem API keys e sem plano novo: o Friday usa as ferramentas de programação com login feito no seu computador.

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
    <td align="center" width="120"><img src="../../docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>Qualquer agente ACP</sub></td>
  </tr>
</table>

## Gratuito e no seu computador

O Friday tem licença MIT, não tem conta nem modelo próprio, e escuta só em `127.0.0.1`. Seu código, seus prompts e seus arquivos nunca chegam até nós. A única coisa que ele envia são algumas contagens de uso anônimas, que você pode desligar ([o que exatamente](#privacy)). O que vendemos é o [Friday Team](https://www.tryfridaywork.com), a versão hospedada para várias pessoas na mesma sessão.

## Mais

<details>
<summary><b>Crew: colegas de IA com memória</b></summary>

Mantenha colegas de IA no seu computador, cada um com nome, função, memória e pasta própria, rodando em uma das suas ferramentas de programação. Dê uma meta ao crew e o líder planeja tudo em um quadro, ou chame um deles com `@`. Salas com threads paralelas, acesso por colega (Read only, Ask before changes, Full access), Away até um horário (os colegas anotam o que assumiram e um resumo fica esperando por você; funciona enquanto o computador estiver ligado e o Friday rodando), uma ferramenta reserva quando uma fica sem uso, e fluxos de trabalho desenhados como etapas.

<img src="../../docs/assets/site/crew-room.png" alt="Uma sala do crew: Kit constrói a página de preços e reporta para Nova em um card, e Nova faz o resumo" width="960" />
</details>

<details>
<summary><b>Regras, memória do projeto e segurança</b></summary>

- **Regras que ficam:** diga a um agente "nunca mexa nas migrations" uma vez e o Friday oferece isso como uma regra contra a qual o trabalho futuro de todos os agentes é verificado.
- **Já estava quebrado?** Um teste que falha roda de novo no código de antes de o agente começar, então falhas antigas ficam marcadas como antigas.
- **Memória do projeto:** as correções ficam guardadas por repo, e todo agente que começa ali recebe essas correções primeiro.
- **Cuidadoso por padrão:** antes de um comando que apaga, faz deploy, publica ou instala, o botão principal é Don't. Segredos (API keys, tokens, URLs de webhook) ficam ocultos no chat e no painel de Git.
</details>

<details>
<summary><b>Automações, Git e todo o resto</b></summary>

- **Automações:** em um horário agendado, por um webhook ou quando outra sessão termina; uma ferramenta ou várias dividindo o trabalho; terminam em um pull request para você revisar.
- **Git integrado:** stage por hunk, commit, push, abrir um PR.
- **Friday Code:** o agente próprio do Friday, com uma API key sua ou um modelo local (Ollama, LM Studio).
- **Deixe outros agentes usarem o Friday:** Claude Code, Codex ou qualquer cliente MCP no seu computador pode iniciar sessões do Friday e passar trabalho para elas (`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`).
- Feed ao vivo, voltar no tempo, preview do servidor de desenvolvimento, terminal, ⌘K para tudo, temas, notificações.
</details>

<details>
<summary><b>Detalhes de instalação: instalação e login de cada ferramenta, Homebrew, configurações</b></summary>

### Ferramentas suportadas e instalação

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| Ferramentas | Instalação | Login |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | rode `gemini` uma vez e faça login |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | rode `agy` uma vez e faça login |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | Faz login na própria primeira tela |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | Faz login na própria primeira tela |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | rode `qwen` uma vez e faça login |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | rode `pi` uma vez e digite `/login` (ou configure a API key de um provedor) |
| **Goose** | **Windows** `irm https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh \| bash` | rode `goose configure` e escolha um provedor |
| **Auggie** | `npm install -g @augmentcode/auggie` | `auggie auth login` |
| **Aider** | **Windows** `powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 \| iex"` <br> **Mac/Linux** `curl -LsSf https://aider.chat/install.sh \| sh` | configure a API key de um provedor (ex.: `ANTHROPIC_API_KEY`) |
| **Crush** | `npm install -g @charmland/crush` | `crush login` (ou a API key de um provedor) |
| **Outro agente ACP** | qualquer agente ACP | qualquer agente ACP |

### O app desktop

| | |
| --- | --- |
| Mac, Apple silicon | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac, Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage) (dê `chmod +x` nele e depois rode) |

No Mac, o Homebrew também instala:

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

Todas as versões estão na [página de releases](https://github.com/splashxmoon/friday-code/releases). O app é o Friday em uma janela própria, com o mesmo servidor dentro, só em `127.0.0.1`.

O app para Mac é assinado e notarizado pela Apple, então abre como qualquer outro.

> [!NOTE]
> O instalador do Windows ainda não é assinado, então o Windows pergunta antes de rodá-lo pela primeira vez: escolha **Mais informações** e depois **Executar assim mesmo**.

### Pelo terminal

Com Node.js 22 ou mais recente e Git:

```bash
npx github:splashxmoon/friday-code
```

O Friday abre no seu navegador em `http://127.0.0.1:4321`. Para ter uma cópia:

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| Configuração | Padrão | O que faz |
| --- | --- | --- |
| `PORT` | `4321` | Onde o Friday escuta, só neste computador. |
| `FRIDAY_HOME` | `~/.friday` | Onde ele guarda suas sessões e configurações. |
| `--no-open` | | Inicia sem abrir o navegador. |
</details>

<details>
<summary id="privacy"><b>Privacidade: exatamente o que é enviado</b></summary>

O Friday escuta só em `127.0.0.1`, então nada mais na sua rede consegue acessá-lo, e ele responde apenas à própria página: uma requisição de qualquer outro site, ou de uma página em preview, é recusada. O que ele guarda é uma pasta no seu computador que só você pode ler.

Ele não tem conta, e seu código, seus prompts e seus arquivos nunca chegam até nós. O que ele envia são algumas contagens de uso anônimas, para sabermos se as pessoas conseguem fazer o Friday funcionar e continuam usando. Todas vão para o [PostHog](https://posthog.com) via HTTPS, com localização por IP e perfis de pessoa desligados; um envio que falha é descartado. Todo o código está em [`src/usage.ts`](../../src/usage.ts).

- Um id aleatório gerado no seu computador para esta instalação, sem ligação com mais nada.
- A versão do Friday, seu sistema (macOS, Windows ou Linux) e a arquitetura dele, e se é o app desktop.
- Uma vez por dia em que você abre: que você abriu, os nomes das ferramentas de programação que ele encontrou e quantas estão com login feito.
- Cada sessão iniciada, e se é do tipo Code ou Crew.
- Uma única vez cada: a primeira vez que uma ferramenta de programação fica pronta, e a primeira vez que um agente termina um turno.

Nunca: prompts, código, nomes ou caminhos de arquivos, nomes de repositórios, endereços de email, contas ou logins, nem nada que uma ferramenta escreva. O Friday pergunta sobre as contagens na tela de boas-vindas na primeira vez que abre (ou em uma nota na barra lateral, se você pular as boas-vindas), e não envia nada antes de você responder. Para desligar, use Settings › Data & backup › Share anonymous usage, ou defina `FRIDAY_NO_TELEMETRY=1` ou `DO_NOT_TRACK=1` onde o Friday roda.

Ele fala com o GitHub para os pull requests, issues e skills sobre os quais você perguntar. O uso restante de cada ferramenta vem da própria ferramenta sempre que possível: o do Claude Code, do que ele informa enquanto roda (o login dele nunca é lido); o do Codex, do próprio app server; o do Copilot, pela sua GitHub CLI. O Cursor não guarda nada no seu computador, então o Friday faz a mesma requisição que a própria CLI do Cursor faz, para o servidor do Cursor e para nenhum outro lugar. Para as outras ferramentas que guardam um login no seu computador (Kilo, OpenCode, Grok, Factory Droid, Antigravity, Cline, Amp e mais algumas), o Friday lê esse login ali só para perguntar ao servidor da própria ferramenta quanto uso ainda resta. Ele não vai para nenhum outro lugar, nunca para nós, e nunca entra nas contagens de uso. O Friday nunca troca a conta com que uma ferramenta está logada. Um modelo que você adiciona em Settings › Your models é chamado a partir do seu computador, e a key dele fica guardada ali e é enviada só para o servidor desse modelo. O app desktop também pergunta ao GitHub se há uma versão mais nova enquanto está aberto (ao iniciar, quando você volta para ele e a cada dez minutos), baixa de lá e instala quando você reinicia (`FRIDAY_NO_UPDATE_CHECK=1` desliga isso).

</details>

<details>
<summary><b>Perguntas frequentes</b></summary>

**Como rodo o Claude Code e o Codex ao mesmo tempo em um projeto?**
Inicie uma sessão no seu repositório com um deles e depois adicione o outro pela barra de agentes da sessão. Cada um pode trabalhar na sua própria cópia do repositório (uma Git worktree), então um não sobrescreve o outro, e o Friday mantém os dois conversando.

**Isso é um framework multiagente que eu preciso programar?**
Não. O Friday usa as CLIs de programação que você já usa, do jeito que elas são. Não há nada para escrever: você escolhe as ferramentas e passa o trabalho para elas.

**Posso começar com um agente só?**
Sim. Uma sessão com uma ferramenta de programação funciona como essa ferramenta, com a revisão, o Git e o preview do Friday em volta. Adicione um segundo agente quando quiser que eles dividam o trabalho.

**Funciona no meu repo atual?**
Sim. Aponte uma sessão para qualquer pasta ou repositório no seu computador. Cada agente que você adicionar pode trabalhar na própria Git worktree dele, e o Friday não troca uma pasta com trabalho sem commit debaixo do seu nariz.

**Preciso de conta, servidor ou assinatura nova?**
Não. O Friday roda no seu computador em `127.0.0.1`, sem conta, e o trabalho roda nas ferramentas de programação em que você já fez login.

**E se uma ferramenta de programação não estiver instalada?**
O Friday só usa as ferramentas que encontra. A tela de configuração mostra quais estão instaladas e com login feito, e pode fazer o login das outras para você.

**Quais agentes de programação ele suporta?**
Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity CLI, OpenCode, Devin CLI, Junie, Kiro, Factory Droid, Grok Build, Cline, Kilo Code, Amp, Muse Code e qualquer agente que fale o Agent Client Protocol (ACP).

**Custa alguma coisa, ou usa minhas API keys?**
O Friday é gratuito e tem licença MIT. O trabalho roda no plano e no login de cada ferramenta, então não há keys para colar nem nada a mais para pagar. Se você também quiser o Friday Code, o agente próprio do Friday, dê a ele uma key sua ou um modelo no seu computador em Settings › Your models: aí ele roda com isso.

**O que acontece quando um agente fica sem uso?**
A tarefa dele vai para o agente mais bem posicionado para terminá-la, com um registro do que o primeiro fez e mudou, então o trabalho continua.

**Ele roda meus agentes quando eu não estou?**
Sim: uma automação inicia uma ferramenta de programação em um horário agendado, por um webhook ou quando outra sessão termina, e abre um pull request para você revisar. O Friday precisa estar rodando para ela começar; você escolhe se uma execução perdida enquanto o computador estava desligado acontece quando ele voltar.

**Meu código sai do meu computador?**
Não pelo Friday. Ele roda em `127.0.0.1` sem conta; suas ferramentas de programação falam com os próprios provedores como sempre. As únicas coisas que o Friday nos envia são as contagens de uso anônimas descritas em [Privacidade](#privacy), que nunca incluem código, e você pode desligá-las.
</details>

<a id="contributing"></a>
## Como contribuir

O Friday é construído de forma aberta e todo pull request recebe resposta em até um dia. Bons pontos de partida:

- **Adicione uma ferramenta de programação.** A maioria das ferramentas é um adaptador curto, e [o guia](../../docs/adding-a-coding-tool.md) mostra como fazer um passo a passo.
- **Empacote.** [Scoop](https://github.com/splashxmoon/friday-code/issues/41) para Windows, [o AUR](https://github.com/splashxmoon/friday-code/issues/40) para Arch.
- **Teste e conte como foi.** [O AppImage de Linux na sua distro](https://github.com/splashxmoon/friday-code/issues/4), [login MCP no Windows e no Linux](https://github.com/splashxmoon/friday-code/issues/26).
- **Outra coisa?** [Comece aqui](https://github.com/splashxmoon/friday-code/issues/42), as [good first issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue), ou uma ideia em [Discussions](https://github.com/splashxmoon/friday-code/discussions).

Para fazer o build: `npm install`, `npm start` (ou `npm run desktop`), `npm test`. O [CONTRIBUTING.md](../../CONTRIBUTING.md) tem o resto. Toda nota de release agradece às pessoas cujo trabalho está nela.

Obrigado a todo mundo que ajudou a construir o Friday:

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Contribuidores do Friday" /></a>

Se o Friday economiza seu tempo, uma ⭐ ajuda outros desenvolvedores a encontrá-lo.

## Licença

[MIT](../../LICENSE)
