<p align="center">
  <img src="../../docs/assets/logo.svg" alt="Friday" width="72" />
</p>

<h1 align="center">Friday</h1>

<p align="center">
  <strong>Une seule app pour tous vos agents de code.</strong><br/>
  Claude Code, Codex, Cursor et 15 autres, avec les abonnements que vous payez déjà. Faites-les tourner côte à côte, ou confiez-leur une tâche : ils se la répartissent, relisent le travail des autres et prennent le relais quand l'un d'eux n'a plus de quota. Gratuit et open source, sur votre propre ordinateur.
</p>

<p align="center"><sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.vi.md">Tiếng Việt</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português</a> · <b>Français</b> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a></sub></p>
<p align="center"><sub>Traduit du README anglais. En cas de différence, c'est la version anglaise qui est à jour.</sub></p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/stargazers"><img src="https://img.shields.io/github/stars/splashxmoon/friday-code?style=flat&label=%E2%98%85&color=08C" alt="Étoiles GitHub" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Licence : MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat" alt="macOS, Windows et Linux" />
  <a href="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml"><img src="https://github.com/splashxmoon/friday-code/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg"><b>Mac (Apple silicon)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg"><b>Mac (Intel)</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe"><b>Windows</b></a> ·
  <a href="https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage"><b>Linux</b></a>
  <br/>ou, avec Node.js 22 : <code>npx github:splashxmoon/friday-code</code>
</p>

<p align="center"><sub>Si Friday vous fait gagner du temps, une ⭐ aide d'autres personnes à le trouver. Envie d'aider à le construire ? <a href="#contributing">Commencez ici</a>.</sub></p>

<p align="center">
  <img src="../../docs/assets/site/hero.png" alt="Friday sur un projet de boutique en ligne d'exemple : le fil checkout-v2 avec une équipe de trois, Amp et Claude Code 2 au travail pendant que Codex répond à la question de savoir si 3-D Secure est couvert par un test, et le panneau Agents qui montre qui a fini et qui travaille encore" width="960" />
</p>

Voyez-le comme une discussion de groupe et un tableau de tâches pour vos agents de code IA.

- **Ils se parlent.** Les agents s'envoient des messages pendant qu'ils travaillent : un avertissement sur un renommage, une question, la réponse. Vous voyez chaque message.
- **Ils se répartissent le travail.** Un agent transforme la tâche en tableau de tâches partagé. Les autres prennent les parties qui leur conviennent, chacun dans sa propre copie de votre dépôt, pour que personne n'écrase le travail d'un autre.
- **Ils se vérifient entre eux.** Une tâche terminée est vérifiée par un autre agent (un modèle différent quand il y en a un de libre). Ensuite, vous lisez le diff, laissez des notes sur n'importe quelle ligne, et vous committez.

Et quand un agent n'a plus de quota, un autre reprend sa tâche avec un historique de ce qui a été fait.

<table>
<tr>
<td width="50%"><img src="../../docs/assets/site/talk.png" alt="Claude Code demande à Codex si le parcours 3-D Secure de checkout-v2 est couvert par un test, et la réponse de Codex arrive dans la discussion" /></td>
<td width="50%"><img src="../../docs/assets/site/board.png" alt="Tâches de l'équipe : Cursor et Kilo travaillent sur le paiement sans compte et l'attente 3-D Secure, quatre autres tâches suivent, chacune attend la précédente" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Ils se parlent.</b> Un agent demande à un autre ce qu'il a trouvé et reçoit la réponse dans la discussion.</sub></td>
<td width="50%" valign="top"><sub><b>Ils se répartissent le travail.</b> Chaque tâche, qui s'en occupe et où elle en est, sur un seul tableau.</sub></td>
</tr>
<tr>
<td width="50%"><img src="../../docs/assets/site/review.png" alt="Friday IDE : une auto-relecture de checkout.ts avec le bug corrigé en note sur la ligne 12 et la carte de relecture : trois corrigés, un pour vous" /></td>
<td width="50%"><img src="../../docs/assets/site/own-copy.png" alt="Ajout de Kilo au dépôt de la boutique, sur son propre worktree et sa propre branche" /></td>
</tr>
<tr>
<td width="50%" valign="top"><sub><b>Ils se vérifient entre eux.</b> Un agent relit la modification et laisse ses remarques sur les lignes avant que vous la lisiez.</sub></td>
<td width="50%" valign="top"><sub><b>Chacun sa copie.</b> Chaque agent a son propre worktree et sa propre branche, pour que personne n'écrase le travail d'un autre.</sub></td>
</tr>
</table>

### Friday IDE

Votre éditeur, votre terminal et vos extensions, avec la discussion de chaque agent juste à côté. Modifiez sur place avec ⌘K, lancez deux ou trois outils de code en parallèle sur une même demande et gardez le meilleur résultat, et obtenez une auto-relecture avant la pull request.

<p align="center">
  <img src="../../docs/assets/site/ide.png" alt="Friday IDE : checkout.ts ouvert dans l'éditeur, et trois outils de code en compétition sur une même demande dans la discussion à côté, chacun avec Compare et Keep" width="960" />
</p>

## Démarrer en cinq minutes

1. **Connectez-vous à un outil de code** que vous utilisez déjà, par exemple `claude auth login` ou `codex login`.
2. **Installez Friday** avec un des liens de téléchargement ci-dessus, ou lancez `npx github:splashxmoon/friday-code` avec Node.js 22.
3. **Ouvrez-le.** Friday liste les outils de code qu'il a trouvés sur votre ordinateur.
4. **Démarrez une session** dans votre dépôt et donnez-lui une tâche.
5. **Relisez ce qui a changé** et gardez ce qui vous plaît.

Un seul agent suffit pour commencer. Ajoutez-en un deuxième quand vous voulez qu'ils se répartissent le travail.

## Fonctionne avec les agents que vous payez déjà

Pas de clé API ni de nouvel abonnement : Friday pilote les outils de code connectés sur votre ordinateur.

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
    <td align="center" width="120"><img src="../../docs/assets/tools/acp.svg" width="32" height="32" alt="" /><br /><sub>N'importe quel agent ACP</sub></td>
  </tr>
</table>

## Gratuit, et sur votre ordinateur

Friday est sous licence MIT, n'a ni compte ni modèle à lui, et n'écoute que sur `127.0.0.1`. Votre code, vos prompts et vos fichiers ne nous parviennent jamais. La seule chose qu'il envoie, ce sont quelques compteurs d'utilisation anonymes, que vous pouvez désactiver ([le détail exact](#privacy)). Ce que nous vendons, c'est [Friday Team](https://www.tryfridaywork.com), la version hébergée pour plusieurs personnes dans une même session.

## Plus

<details>
<summary><b>Crew : des coéquipiers IA avec une mémoire</b></summary>

Gardez des coéquipiers IA sur votre ordinateur, chacun avec un nom, un rôle, une mémoire et son propre dossier, sur l'un de vos outils de code. Donnez un objectif à l'équipe et le responsable le planifie sur un tableau, ou mentionnez l'un d'eux avec `@`. Il y a des salons avec des fils secondaires, des droits par coéquipier (Read only, Ask before changes, Full access) et un mode Away jusqu'à une heure donnée (les coéquipiers notent leurs hypothèses et un résumé vous attend ; cela fonctionne tant que votre ordinateur reste allumé et que Friday tourne). Il y a aussi un outil de secours quand l'un n'a plus de quota, et des workflows dessinés sous forme d'étapes.

<img src="../../docs/assets/site/crew-room.png" alt="Un salon de l'équipe : Kit construit la page de tarifs et rend compte à Nova dans une seule carte, puis Nova fait le point" width="960" />
</details>

<details>
<summary><b>Règles, mémoire du projet et sécurité</b></summary>

- **Des règles qui restent :** dites une fois à un agent « ne touche jamais aux migrations » et Friday vous propose d'en faire une règle, à laquelle le travail ultérieur de chaque agent est comparé.
- **C'était déjà cassé ?** Un test qui échoue est relancé sur le code d'avant le début du travail de l'agent, pour que les anciens échecs soient marqués comme anciens.
- **Mémoire du projet :** les corrections sont gardées par dépôt, et chaque agent qui y démarre en est informé en premier.
- **Prudent par défaut :** avant une commande qui supprime, déploie, publie ou installe, Don't est le bouton principal. Les secrets (clés API, jetons, URL de webhook) sont masqués dans la discussion et dans le panneau Git.
</details>

<details>
<summary><b>Automatisations, Git et tout le reste</b></summary>

- **Automatisations :** selon un planning, via un webhook, ou quand une autre session se termine ; un seul outil ou plusieurs qui se répartissent le travail ; le tout se termine par une pull request à relire.
- **Git intégré :** indexer par bloc, committer, pousser, ouvrir une PR.
- **Friday Code :** l'agent de Friday, avec une de vos clés API ou un modèle local (Ollama, LM Studio).
- **Laissez d'autres agents utiliser Friday :** Claude Code, Codex ou n'importe quel client MCP sur votre ordinateur peut démarrer des sessions Friday et leur confier du travail (`claude mcp add friday --scope user -- node ~/.friday/outside-mcp.mjs`).
- Flux en direct, retour en arrière, aperçu du serveur de dev, terminal, ⌘K pour tout, thèmes, notifications.
</details>

<details>
<summary><b>Détails d'installation : installation et connexion de chaque outil, Homebrew, paramètres</b></summary>

### Outils pris en charge et installation

<!-- Note: Install commands are duplicated from TOOL_INFO in src/types.ts. -->

| Outils | Installation | Connexion |
| :--- | :--- | :--- |
| **Claude Code** | **Windows:** `irm https://claude.ai/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://claude.ai/install.sh \| bash` | `claude auth login` |
| **Codex** | `npm install -g @openai/codex` | `codex login` |
| **Cursor** | **Windows:** `irm 'https://cursor.com/install?win32=true' \| iex`<br /> **Mac/Linux:** `curl https://cursor.com/install -fsS \| bash` | `cursor-agent login` |
| **GitHub Copilot** | `npm install -g @github/copilot` | `copilot login` |
| **Gemini CLI** | `npm install -g @google/gemini-cli` | lancez `gemini` une fois et connectez-vous |
| **Antigravity CLI** | **Windows:** `irm https://antigravity.google/cli/install.ps1 \| iex`<br>**Mac/Linux:** `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | lancez `agy` une fois et connectez-vous |
| **OpenCode** | `npm install -g opencode-ai` | `opencode auth login` |
| **Devin** | **Windows** `irm https://static.devin.ai/cli/setup.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.devin.ai/install.sh \| bash` | `devin auth login` |
| **Junie** | **Windows** `irm https://junie.jetbrains.com/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://junie.jetbrains.com/install.sh \| bash` | Connexion sur son propre premier écran |
| **Kiro** | **Windows** `irm 'https://cli.kiro.dev/install.ps1' \| iex` <br> **Mac/Linux** `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| **Droid** | **Windows** `irm https://app.factory.ai/cli/windows \| iex` <br> **Mac/Linux** `curl -fsSL https://app.factory.ai/cli \| sh` | Connexion sur son propre premier écran |
| **Grok** | **Windows** `irm https://x.ai/cli/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` |
| **Cline** | `npm install -g cline` | `cline auth` |
| **Kilo** | `npm install -g @kilocode/cli` | `kilo auth login` |
| **Amp** | `npm install -g @ampcode/cli` | `amp login` |
| **Muse Code** | **Windows** `irm https://dev.meta.ai/install.ps1 \| iex` <br> **Mac/Linux** `curl -fsSL https://dev.meta.ai/install.sh \| sh` | `muse login` |
| **Qwen Code** | `npm install -g @qwen-code/qwen-code` | lancez `qwen` une fois et connectez-vous |
| **Pi** | `npm install -g @mariozechner/pi-coding-agent` | lancez `pi` une fois et tapez `/login` (ou définissez la clé API d'un fournisseur) |
| **Autre agent ACP** | selon l'agent ACP | selon l'agent ACP |

### L'application de bureau

| | |
| --- | --- |
| Mac, Apple silicon | [Friday-arm64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-arm64.dmg) |
| Mac, Intel | [Friday-x64.dmg](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x64.dmg) |
| Windows | [Friday-Setup.exe](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-Setup.exe) |
| Linux | [Friday-x86_64.AppImage](https://github.com/splashxmoon/friday-code/releases/latest/download/Friday-x86_64.AppImage) (faites un `chmod +x` dessus, puis lancez-le) |

Sur Mac, Homebrew peut aussi l'installer :

```bash
brew tap splashxmoon/friday-code https://github.com/splashxmoon/friday-code
brew trust splashxmoon/friday-code
brew install --cask friday
```

Toutes les versions sont sur la [page des releases](https://github.com/splashxmoon/friday-code/releases). L'application, c'est Friday dans sa propre fenêtre, avec le même serveur à l'intérieur, uniquement sur `127.0.0.1`.

L'application Mac est signée et notarisée par Apple, elle s'ouvre donc comme n'importe quelle autre.

> [!NOTE]
> L'installateur Windows n'est pas encore signé, donc Windows demande une confirmation avant de le lancer la première fois : choisissez **Informations complémentaires**, puis **Exécuter quand même**.

### Depuis un terminal

Avec Node.js 22 ou plus récent, et Git :

```bash
npx github:splashxmoon/friday-code
```

Friday s'ouvre dans votre navigateur à l'adresse `http://127.0.0.1:4321`. Pour en garder une copie :

```bash
git clone https://github.com/splashxmoon/friday-code
cd friday-code
npm install
npm start
```

| Paramètre | Par défaut | Rôle |
| --- | --- | --- |
| `PORT` | `4321` | Le port où Friday écoute, sur cet ordinateur uniquement. |
| `FRIDAY_HOME` | `~/.friday` | L'endroit où il garde vos sessions et vos réglages. |
| `--no-open` | | Démarrer sans ouvrir le navigateur. |
</details>

<details>
<summary id="privacy"><b>Confidentialité : exactement ce qui est envoyé</b></summary>

Friday n'écoute que sur `127.0.0.1`, donc rien d'autre sur votre réseau ne peut l'atteindre, et il ne répond qu'à sa propre page : une requête venant d'un autre site, ou d'une page en cours d'aperçu, est refusée. Ce qu'il conserve tient dans un seul dossier sur votre ordinateur, lisible par vous seul.

Il n'a pas de compte, et votre code, vos prompts et vos fichiers ne nous parviennent jamais. Ce qu'il envoie, ce sont quelques compteurs d'utilisation anonymes, pour que nous puissions voir si les gens arrivent à faire fonctionner Friday et continuent à s'en servir. Chacun d'eux part vers [PostHog](https://posthog.com) en HTTPS, avec la localisation par IP et les profils de personne désactivés ; un envoi qui échoue est abandonné. Tout le code est dans [`src/usage.ts`](../../src/usage.ts).

- Un identifiant aléatoire créé sur votre ordinateur pour cette installation, lié à rien d'autre.
- La version de Friday, votre système (macOS, Windows ou Linux) et son architecture, et s'il s'agit de l'application de bureau.
- Une fois par jour où vous l'ouvrez : le fait que vous l'avez ouvert, les noms des outils de code trouvés, et combien sont connectés.
- Chaque session démarrée, et s'il s'agit d'une session Code ou Crew.
- Une seule fois chacun : la première fois qu'un outil de code est prêt, et la première fois qu'un agent termine un tour.

Jamais : les prompts, le code, les noms ou chemins de fichiers, les noms de dépôts, les adresses e-mail, les comptes ou connexions, ni rien de ce qu'écrit un outil. Friday vous pose la question des compteurs dans son écran d'accueil à la première ouverture (ou dans une note de la barre latérale si vous passez l'accueil), et n'envoie rien avant votre réponse. Pour les désactiver, allez dans Settings › Data & backup › Share anonymous usage, ou définissez `FRIDAY_NO_TELEMETRY=1` ou `DO_NOT_TRACK=1` là où Friday tourne.

Il contacte GitHub pour les pull requests, issues et skills que vous lui demandez. Le quota restant de chaque outil vient de l'outil lui-même chaque fois que c'est possible : celui de Claude Code à partir de ce qu'il indique pendant qu'il tourne (sa connexion n'est jamais lue), celui de Codex depuis son propre serveur d'app, celui de Copilot via votre GitHub CLI. Cursor ne garde rien sur votre ordinateur, donc Friday fait la même requête que la CLI de Cursor, vers le serveur de Cursor et nulle part ailleurs. Pour les autres outils qui gardent une connexion sur votre ordinateur (Kilo, OpenCode, Grok, Factory Droid, Antigravity, Cline, Amp et quelques autres), Friday la lit sur place uniquement pour demander au serveur de cet outil combien de quota il vous reste. Elle ne va nulle part ailleurs, jamais chez nous, et jamais dans les compteurs d'utilisation. Friday ne change jamais le compte avec lequel un outil est connecté. Un modèle que vous ajoutez dans Settings › Your models est appelé depuis votre ordinateur, et sa clé y reste, envoyée uniquement au serveur de ce modèle. L'application de bureau demande aussi à GitHub s'il existe une version plus récente tant qu'elle est ouverte (au démarrage, quand vous y revenez, et toutes les dix minutes), la télécharge depuis GitHub et l'installe au redémarrage (`FRIDAY_NO_UPDATE_CHECK=1` désactive cela).

</details>

<details>
<summary><b>FAQ</b></summary>

**Comment faire tourner Claude Code et Codex en même temps sur un même projet ?**
Démarrez une session dans votre dépôt avec l'un des deux, puis ajoutez l'autre depuis la barre des agents de la session. Chacun peut travailler dans sa propre copie du dépôt (un worktree Git), pour qu'ils ne s'écrasent pas mutuellement, et Friday les fait communiquer.

**Est-ce un framework multi-agents pour lequel je dois écrire du code ?**
Non. Friday pilote les CLI de code que vous utilisez déjà, telles quelles. Il n'y a rien à écrire : vous choisissez les outils et vous leur donnez la tâche.

**Puis-je commencer avec un seul agent ?**
Oui. Une session avec un seul outil de code fonctionne comme cet outil, avec en plus la relecture, Git et l'aperçu de Friday. Ajoutez un deuxième agent quand vous voulez qu'ils se répartissent le travail.

**Est-ce que ça marche sur mon dépôt existant ?**
Oui. Pointez une session vers n'importe quel dossier ou dépôt de votre ordinateur. Les agents que vous ajoutez peuvent chacun travailler dans leur propre worktree Git de ce dépôt, et Friday ne changera pas de branche sous vos pieds dans un dossier qui contient du travail non commité.

**Ai-je besoin d'un compte, d'un serveur ou d'un nouvel abonnement ?**
Non. Friday tourne sur votre ordinateur à l'adresse `127.0.0.1`, sans compte, et le travail passe par les outils de code auxquels vous êtes déjà connecté.

**Et si un outil de code n'est pas installé ?**
Friday n'utilise que les outils qu'il trouve. Son écran de configuration montre lesquels sont installés et connectés, et peut connecter les autres pour vous.

**Quels agents de code sont pris en charge ?**
Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, Antigravity CLI, OpenCode, Devin CLI, Junie, Kiro, Factory Droid, Grok Build, Cline, Kilo Code, Amp, Muse Code, et tout agent qui parle l'Agent Client Protocol (ACP).

**Est-ce payant, ou est-ce que ça utilise mes clés API ?**
Friday est gratuit et sous licence MIT. Le travail passe par l'abonnement et la connexion de chaque outil, donc il n'y a aucune clé à coller et rien de plus à payer. Si vous voulez aussi Friday Code, l'agent de Friday, donnez-lui une de vos clés ou un modèle sur votre ordinateur dans Settings › Your models : il tournera alors avec ça.

**Que se passe-t-il quand un agent n'a plus de quota ?**
Sa tâche va à l'agent le mieux placé pour la finir, avec un historique de ce que le premier a fait et modifié, pour que le travail continue.

**Peut-il faire tourner mes agents quand je ne suis pas là ?**
Oui : une automatisation démarre un outil de code selon un planning, via un webhook, ou quand une autre session se termine, et ouvre une pull request à relire. Friday doit tourner pour qu'elle démarre ; vous choisissez si une exécution manquée pendant que l'ordinateur était éteint a lieu à son retour.

**Est-ce que mon code quitte mon ordinateur ?**
Pas via Friday. Il tourne sur `127.0.0.1` sans compte ; vos outils de code parlent à leurs propres fournisseurs comme d'habitude. Les seules choses que Friday nous envoie sont les compteurs d'utilisation anonymes décrits dans [Confidentialité](#privacy), qui ne contiennent jamais de code, et vous pouvez les désactiver.
</details>

<a id="contributing"></a>
## Contribuer

Friday est développé en public et chaque pull request reçoit une réponse en moins d'un jour. Quelques bons points de départ :

- **Ajouter un outil de code.** La plupart des outils tiennent dans un petit adaptateur : [goose](https://github.com/splashxmoon/friday-code/issues/36), [Auggie](https://github.com/splashxmoon/friday-code/issues/37), [Aider](https://github.com/splashxmoon/friday-code/issues/38) et [Crush](https://github.com/splashxmoon/friday-code/issues/39) attendent preneur, et [le guide](../../docs/adding-a-coding-tool.md) en détaille un pas à pas.
- **Le packager.** [Scoop](https://github.com/splashxmoon/friday-code/issues/41) pour Windows, [l'AUR](https://github.com/splashxmoon/friday-code/issues/40) pour Arch.
- **L'essayer et faire un retour.** [L'AppImage Linux sur votre distribution](https://github.com/splashxmoon/friday-code/issues/4), [la connexion MCP sur Windows et Linux](https://github.com/splashxmoon/friday-code/issues/26).
- **Autre chose ?** [Commencez ici](https://github.com/splashxmoon/friday-code/issues/42), avec les [good first issues](https://github.com/splashxmoon/friday-code/labels/good%20first%20issue), ou proposez une idée dans [Discussions](https://github.com/splashxmoon/friday-code/discussions).

Pour le compiler : `npm install`, `npm start` (ou `npm run desktop`), `npm test`. [CONTRIBUTING.md](../../CONTRIBUTING.md) contient le reste. Chaque note de version remercie les personnes dont le travail s'y trouve.

Merci à toutes les personnes qui ont aidé à construire Friday :

<a href="https://github.com/splashxmoon/friday-code/graphs/contributors"><img src="https://contrib.rocks/image?repo=splashxmoon/friday-code" alt="Les contributeurs de Friday" /></a>

Si Friday vous fait gagner du temps, une ⭐ aide d'autres développeurs à le trouver.

## Licence

[MIT](../../LICENSE)
