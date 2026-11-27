# MCP servers in Friday

An MCP server gives a coding tool more to work with: your issues, your docs, a database, a design file. In Friday you set one up once, on the **Plugins** page, and your coding tools get it from then on. Open **Customize** on the rail and pick **Plugins**, or find **Plugins** with ⌘K.

## What the page does

You connect a server once, and Friday hands it to these tools on their next turn, with no restart:

- Claude Code
- Codex
- Amp
- the tools Friday runs over ACP (Copilot, Gemini, OpenCode, Kilo and the rest)

Friday doesn't hand them to Cursor, Aider, Crush, Muse or Pi.

A few limits:

- Codex doesn't get servers on the older SSE transport, such as an address ending in `/sse`.
- An ACP tool always gets the servers that run on this computer. It gets remote ones only if it says it can talk to them.

## Connecting a service from the directory

The page lists services by kind, with a search and a filter for each kind. Each card says how it connects:

- **Sign in**: Friday opens the service's sign-in page in your browser. Once you've allowed it, the browser comes back to Friday on this computer and the sheet updates by itself ("Finish signing in to ... in your browser. This updates by itself."). If nothing comes back within five minutes, start it again.
- **Your app**: Slack, GitHub, HubSpot, Box, Zendesk and PagerDuty don't let apps register themselves. When Friday has no app of its own with one of them, you register one: **Register one** opens the right page, the sheet says what to do there, and **Copy** gives you the **Redirect address** to paste in. Then fill in **Client ID** and **Client secret** and sign in. GitHub also takes a personal access token instead.
- **Key** or **Optional key**: paste the service's key and press **Connect**. It's sent as a Bearer token.
- **Runs here**: the server runs on this computer, like Figma's desktop server. Start it first, then connect. You can change its address.

Friday tests each one as it connects and shows how many tools it has. When a sign-in is about to run out, Friday refreshes it, if it can, before handing it to a tool.

A few services from the hosted edition (Gmail, Google Calendar, Google Chat, Calendly, Similarweb) aren't listed here, because they can't be used from this computer yet.

## Adding your own server

Press **Custom server**. Pick where it runs:

- **Remote**: give its **Server URL**, and an **API key** if it needs one (sent as a Bearer token). An address ending in `/sse` is spoken to with the older SSE transport.
- **Runs here**: give the **Command** that starts it, and a **Key** as an environment variable name and its value if it needs one.

The name is optional: left empty, Friday names it from the address or the command. Then press **Add and test**.

If the server's docs give you something to paste, press **Paste a config instead**. The box takes:

- a URL
- a `claude mcp add ...` or `claude mcp add-json ...` line
- a `codex mcp add ...` line
- a command that starts a server (`npx`, `uvx`, `docker run`, `node`, `python` and the like)
- a JSON block: an `mcpServers` map, servers by name, or a single server

Only what's left as a placeholder in its environment variables or headers is asked for: an empty value, a `$VAR`, `YOUR_...`, `<...>` and the like. In a header such as `Authorization: Bearer YOUR_KEY`, you paste the key and `Bearer ` stays in front. For example:

```
claude mcp add github -e GITHUB_TOKEN=YOUR_TOKEN -- npx -y @modelcontextprotocol/server-github
```

asks only for `GITHUB_TOKEN`, and this block adds two servers and asks only for the `Authorization` key:

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"] },
    "acme": { "type": "http", "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer YOUR_KEY" } }
  }
}
```

When you add a server, Friday starts it once, does the MCP handshake and asks for its list of tools. If that works, it's on for every tool. If it doesn't, it's still saved, turned off, with the reason in plain words, and you'll find it under **Your own**.

A remote server that wants you to sign in, rather than take a key, shows **Needs sign-in**: Custom server takes a key, not a sign-in.

Names are kept unique. `friday`, `claude`, `codex`, `computer` and `browser` are Friday's own, so a server given one of them gets `-mcp` added (`claude-mcp`), and a second `github` becomes `github-2`.

Only add servers from people you trust: Friday can't check what their tools do, or that they won't change.

## Turning a server off, testing it, signing in again, disconnecting

Open a connected card to manage it. Its state is at the top: **Connected**, **Off**, **Key refused**, **Needs sign-in**, **Didn't answer** or **Not tested yet**.

- **On for every tool** turns it off or on, from the next turn.
- **Test again** runs the handshake again and lists its tools.
- **Sign in again**, **Change its key** or **Connect again**, for a service from the directory.
- **Change its keys** (or **Fix its keys**, after a key was refused), for one of your own. A field left empty keeps the value it has, and new keys are tested as you save them.
- **Disconnect** asks first, then takes it off every coding tool and deletes its key or sign-in from this computer.

If your Claude Code has servers of its own (in `~/.claude.json`), the **Claude Code servers** switch hands them to the other tools too. It's off by default, since every tool a server has is described to the model on every call. Claude Code has them already.

## Where keys and sign-ins are kept

On this computer, in `~/.friday/connections.json`. On macOS and Linux it's readable by you alone (mode 0600); on Windows it sits in your user folder.

- The page is told which keys a server has, never what they are, and a key you've typed isn't shown again.
- Claude Code is handed the servers in a config file of its own under `~/.friday/run`, written the same way.
- Codex gets each key in its environment, never on its command line.
- Disconnecting a server deletes its key or sign-in from the file.

## Not covered here

- A project's own `.mcp.json`: Claude Code reads it by itself, and Friday passes its servers to the ACP tools too, with `${VAR}` and `${VAR:-default}` filled in from the environment. A server whose variable has no value isn't passed.
- Friday as an MCP server, so other agents can start Friday sessions: see "Let other agents use Friday" in the [README](../README.md).
