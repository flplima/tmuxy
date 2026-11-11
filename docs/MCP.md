# MCP

`tmuxy server` serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at `POST /mcp`. Any MCP client (Claude Code, Cursor, Zed, …) can then see and drive the tmux session tmuxy shows — the same thing agents already do with the CLI (`tmuxy pane list`, `tmuxy pane capture`, `tmuxy pane send`), as typed tools instead of shell commands.

`tmuxy mcp` prints the endpoint for the session the calling pane is in, and the command that adds it to Claude Code:

```sh
tmuxy mcp                    # http://127.0.0.1:9000/mcp
tmuxy mcp --read-only        # http://127.0.0.1:9000/mcp?read-only
claude mcp add --transport http tmuxy 'http://127.0.0.1:9000/mcp'
```

The desktop app talks to its UI over Tauri IPC and serves no HTTP, so the endpoint needs `tmuxy server` running (it can share the desktop app's tmux socket).

## Transport

MCP's Streamable HTTP transport, the JSON half of it: every request is one JSON-RPC message in a `POST`, answered with one JSON response. The server never opens an event stream (it has nothing to push), so `GET /mcp` is a `405`, and a notification is answered `202`. It speaks protocol revisions `2025-06-18`, `2025-03-26` and `2024-11-05`, and offers tools only.

| Query             | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `?session=<name>` | The session to drive. Default: `tmuxy`. A session that does not exist is never created for an agent. |
| `?read-only`      | Only the tools that change nothing are listed or callable: eyes, no hands.                           |

The handshake hands out an `Mcp-Session-Id`; the server keeps only the name the client introduced itself with under it (a bounded list), which is what the question over a pane calls the sender. A request without one still works, and its sender is "an MCP client".

## Tools

One per CLI command, each the same operation (`packages/tmuxy-server/src/mcp/tools.rs`). A pane is named by its id (`%3`), its `@tmuxy-label`, or its title; a name that matches several panes changes nothing.

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

- **`pane_capture`** answers plain text, wrapped lines joined and trailing blanks dropped, with the cursor position and the pane's size, read in one command list so they describe the same moment. Colours are left out: a model reads text.
- **`pane_wait_for`** waits until a pane's screen matches a regular expression, polling a few times a second, up to a timeout. `^` and `$` match at each line. A timeout answers the screen's last lines, which is usually why.
- **Nothing moves the user's focus.** A split, a tab and a float open beside what the user is doing, without taking the keyboard.
- **`pane_float` and `open_preview`** send the float's one command list (`tmuxy-core/src/float.rs`, the list `tmuxy pane float` makes, with the same default size) over the monitor's control-mode channel, from the anchor pane, and read the new pane's id from what the list prints. An agent's `command` runs under `bash -c`, whatever the user's shell.

## The defaults

- **Everything goes through control mode.** Each call reaches tmux down the session's control-mode connection, routed by `command_router` like a browser's commands — reads through `route_query`, mutations through `route_command` — never a `tmux` subprocess beside it, which crashes tmux 3.3a–3.5a. When no browser is watching, the first call attaches the session's monitor and holds it for a few minutes after the last call (`AGENT_HOLD` in `tmuxy-server/src/sse/clients.rs`), so an agent that calls every few seconds does not attach control mode each time, and one that went away does not keep it attached.
- **The user's `permissions.json` is heard first** ([PERMISSIONS.md](PERMISSIONS.md)): a client is bound by the rules under its own name and under `mcp`, and a denied send fails as forbidden without a question.
- **Typing into a pane asks first.** `pane_send_keys` puts the same question on the target pane that `tmuxy pane send -t` does (the `@tmuxy-ask` protocol, `tmuxy-core/src/ask.rs`), naming the client, and blocks until the user answers there: the keys go on yes, nothing goes on no or on a timeout, and a client that hangs up takes its question down. `@tmuxy-send-ask off` skips the question, and so does an `@tmuxy-send-allow` entry naming the client as it introduced itself (`claude-code`), the pane, or `mcp` for every MCP client, or an `@tmuxy-send-allow-into` entry naming the program in the target pane (`claude,agy`: an agent's prompt). An agent cannot change either option through the endpoint.
- **HTTP, behind the server's own guard.** `/mcp` is an API route like `/commands`: the same Basic auth when the server has a password, and the same `request_guard`, so a page on another origin cannot drive it with the user's browser. See [SECURITY.md](SECURITY.md).

## Related

- [SECURITY.md](SECURITY.md) — what an agent with the write tools can do
- [DATA-FLOW.md](DATA-FLOW.md) — the other HTTP endpoints
- [TMUX.md](TMUX.md) — why nothing runs `tmux` beside control mode
