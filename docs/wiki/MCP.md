Let an MCP client such as Claude Code, Cursor or Zed see and drive your tmux session, with typed tools instead of shell commands.

`tmuxy server` serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `/mcp`. It does the same things an agent does with `tmuxy pane list`, `pane capture` and `pane send`.

## Connect a client

```sh
# print the endpoint for the session this pane is in, and how to add it
tmuxy mcp

# the same, with tools that only read
tmuxy mcp --read-only

# add it to Claude Code
claude mcp add --transport http tmuxy 'http://127.0.0.1:9000/mcp'
```

The server must be running. The desktop app serves no HTTP, so start `tmuxy server` yourself. It can share the desktop app's tmux socket.

Other clients take the same URL over Streamable HTTP. Look in your client's docs for where it goes. If the server has a password, the client must send HTTP Basic credentials. Any username works.

### Options for `tmuxy mcp`

| Option           | What it does                                            |
| ---------------- | ------------------------------------------------------- |
| `--port N`       | The server's port (default 9000)                        |
| `--host H`       | The server's address (default 127.0.0.1)                |
| `--session NAME` | The session to drive (default: the one this pane is in) |
| `--read-only`    | Only the tools that change nothing                      |
| `--json`         | Print the answer as JSON                                |

### Options in the URL

| Query             | What it does                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `?session=<name>` | The session to drive. Default `tmuxy`. A session that does not exist is never created for an agent |
| `?read-only`      | Only the read tools are listed or callable: eyes, no hands                                         |

## The tools

Each tool is one CLI command. A pane is named by its id (`%3`), its `@tmuxy-label`, or its title. A name that matches several panes changes nothing.

| Tool             | Same as                        | Changes things? |
| ---------------- | ------------------------------ | --------------- |
| `status`         | `tmuxy --json`                 | no              |
| `pane_list`      | `tmuxy pane list --all --json` | no              |
| `tab_list`       | `tmuxy tab list --json`        | no              |
| `pane_capture`   | `tmuxy pane capture`           | no              |
| `pane_wait_for`  | a `pane capture` loop          | no              |
| `pane_split`     | `tmuxy pane split`             | yes             |
| `pane_send_keys` | `tmuxy pane send -t`           | yes             |
| `pane_float`     | `tmuxy pane float`             | yes             |
| `tab_create`     | `tmuxy tab create`             | yes             |
| `open_preview`   | `tmuxy open <file>`            | yes             |
| `pane_kill`      | `tmuxy pane kill`              | yes             |

- **`pane_list`** answers `id`, `tab`, `width`, `height`, `command`, `title`, `label`, `state` and `cwd` for each pane, plus its `kind` (tab, float or sidebar). Its `active` is the one pane you have focused.
- **`pane_capture`** answers plain text with wrapped lines joined and trailing blanks dropped. It adds the cursor position and the pane's size, read at the same moment. Colours are left out.
- **`pane_wait_for`** waits until a pane's screen matches a regular expression, up to a timeout. `^` and `$` match at each line. On a timeout it answers the screen's last lines.
- **`pane_float`** runs an agent's `command` under `bash -c`, whatever your shell is.

Nothing an agent does moves your focus. A split, a tab or a float opens beside what you are doing, without taking the keyboard.

## Defaults and limits

- **Typing asks first.** `pane_send_keys` puts the same question on the target pane as `tmuxy pane send -t`. It names the client and blocks until you answer. Keys go on yes. Nothing goes on no or on a timeout. A client that hangs up takes its question down.
- **Skipping the question** takes an `@tmuxy-send-allow` entry naming the client (as it introduced itself, like `claude-code`), the pane, or `mcp` for every MCP client. An `@tmuxy-send-allow-into` entry naming the program in the target pane does it too. An agent cannot change either option through the endpoint. See [[Send Permissions]].
- **Nothing is typed at a prompt.** A send is refused when the target needs you or shows an approval dialog, asked or not.
- **Your `permissions.json` is heard first.** A client is bound by the rules under its own name and under `mcp`. A denied send fails as forbidden, with no question.
- **Opening things does not ask.** A pane, tab or float an agent opens runs the command it gives. That program can be anything, `tmux` included.
- **It is read-only on request.** `?read-only` removes every tool that changes anything.
- **A held connection.** With no browser open, the first call attaches the session and holds it for a few minutes after the last call.

## Protocol details

Every request is one JSON-RPC message in a `POST`, answered with one JSON response. The server never opens an event stream, so `GET /mcp` is a 405. It speaks protocol revisions `2025-06-18`, `2025-03-26` and `2024-11-05`, and offers tools only.

The handshake hands out an `Mcp-Session-Id`. The server keeps only the name the client introduced itself with, and uses it as the sender's name in the question. A request without one still works, and its sender is "an MCP client".

## Security notes

`/mcp` is an API route like `/commands`. It sits behind the same password and the same origin checks, so a page on another origin cannot drive it with your browser. Whoever can call it could already call `/commands`.

What it adds is a shape that an agent without a shell can use. Treat it as a shell:

- Do not put it on a routable address without a password and TLS. See [[Remote Access]].
- Give an agent the `?read-only` URL when it should watch.
- Remember that a pane, tab or float an agent opens runs its command without asking.

More in [[Security]].

## See also

- [[AI Agents]]
- [[Send Permissions]]
- [[Security]]
- [MCP in the repo docs](https://github.com/flplima/tmuxy/blob/main/docs/MCP.md)
