What tmuxy protects, what it cannot, and what to do about it. Read this before you put the server on a network or give an agent a pane.

> [!WARNING]
> tmuxy is under active development. It has not had a security audit. It is built for one user on a trusted network.

## The trust model

tmuxy is a window onto your tmux session, and tmux is a shell. Whoever tmuxy lets in can run any command as you.

So tmuxy assumes one user, a trusted network, a server run by the same user who owns the tmux session, and clients that all trust each other. It does not trust your browser: other sites you visit can try to send requests to the server.

## What is protected by default

- **Loopback only.** The server listens on `127.0.0.1`. A routable `--host` is refused unless you set a password or pass `--no-auth`.
- **Other sites cannot drive it.** Every API route checks `Sec-Fetch-Site`, `Origin` and `Host`. A page on another origin, including another port on localhost, gets refused. This also stops DNS rebinding.
- **No CORS headers.** Even a request that slips through cannot be read by another origin.
- **A strict content policy.** The app loads scripts, styles and fonts from its own origin only, and refuses to be framed by another site.
- **No shell in the server.** Commands from a client go to tmux as tmux commands. Session names and pane ids are held to a safe alphabet, and pastes are escaped.
- **Untrusted terminal output.** Escape sequences, links, images and clipboard writes from a pane are parsed with size limits. Links open only with a safe scheme (`http`, `https`, `mailto`, `git`).
- **Typing into another pane asks first.** See [[Send Permissions]].
- **Snapshots stay private.** Saved sessions live in your state directory with owner-only permissions. A restore offers the programs that were running and never runs them unless you pass `--run`.

## Risks

| Risk                              | When it bites                                                                     | What to do                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Exposed server                    | You use a routable `--host`, or a container publishes the port on every interface | Keep the loopback default. Reach it by SSH tunnel or VPN. See [[Remote Access]]   |
| No TLS                            | You use plain HTTP over a network                                                 | Basic auth sends the password as base64. Use a tunnel, a VPN or a TLS proxy       |
| `--no-auth` on a routable address | Anyone who can reach the port gets a shell                                        | Use a password, or keep it to an isolated network                                 |
| Arbitrary commands                | Anyone let in can run `run-shell` or type into any pane                           | It is by design. Control who can reach the server                                 |
| Old browsers                      | A browser with no Fetch Metadata and no `Origin` on a simple `GET`                | A hostile page can open an event stream but cannot read it. Use a current browser |
| No audit log                      | You need to know who did what                                                     | There is none. Refused cross-origin requests are logged as warnings               |
| Old tmux with Sixel               | tmux 3.6a or older, built with Sixel                                              | Use tmux 3.7a or newer                                                            |

## AI agents in your session

An agent that can run commands on your machine can use your tmux session. It can read every pane, type into panes, run shell commands and open or close tabs.

**The send question.** `tmuxy pane send -t` into a pane that is not the caller's own asks you in that pane first. It blocks until you answer. Nothing is typed on no, or on a timeout. You can switch the question off, and you can allow named callers or programs. The details are in [[Send Permissions]].

**Nothing types at a prompt.** A send is refused when the target needs you or shows an approval dialog, asked or not. No part of tmuxy answers a prompt for you.

**What the question cannot stop:**

- An agent that runs raw `tmux` on the socket as your user. tmux has no notion of which client may do what. Close that door in the agent's own permissions, for Claude Code with deny rules such as `Bash(tmux *)`.
- `tmuxy pane run` and `tmuxy pane float`. They start the program they are given, with no question. That program can be `tmux` or a shell that runs it. Do not allow `Bash(tmuxy *)` wholesale. Allow the subcommands the agent needs.
- Plugins. Their commands are not bound by the question.

**Prompt injection.** Text in a pane can look like instructions. If an agent reads panes and acts on them, a hostile program, file or commit message can steer it. Review what an agent runs, and keep agents with internet access away from sessions that hold credentials.

**`/mcp`.** The MCP endpoint is the same remote shell as `/commands`, as typed tools. It sits behind the same password and origin rules. Typing into an existing pane asks you, as the CLI does. Opening a pane, tab or float runs the agent's command without asking. Give an agent the `?read-only` URL when it should watch and not act. See [[MCP]].

`@tmuxy-send-allow-into claude,agy` lets every sender type into those agents' prompts without asking. What it types, that agent then acts on with its own permissions.

## Plugins run as you

A plugin's commands run unsandboxed, with your permissions and the tmux socket. They can read and type into every pane. Nothing tmuxy sets can confine them.

The install gate is the only check. It shows what a plugin can do before anything runs, and pins the install to the commit it showed you. Read it before you accept. See [[Plugins]].

## Previews and widgets

`tmuxy open <file>` shows a markdown or HTML file in a pane. tmuxy treats the file as hostile.

- **Markdown** is rendered by the app with raw HTML filtered. Scripts, iframes and event handlers are dropped. Remote images load only with `--net`.
- **HTML pages** run in a sandboxed frame with no cookies, no storage and no access to the app. Without `--net` they can fetch nothing.
- **What a preview reads** is the one file you named and what sits beside it in the same folder, never hidden names like `.ssh` or `.env`.
- **A page can send lines to its own pane** with `tmuxy.emit`. The line is one short line of safe characters and rate limited. A script that listens treats it as data, never as a command.

## Telemetry

tmuxy collects none. The server, the desktop app and the CLI send nothing about you to anyone. No analytics, no crash reports, no update check.

These are the connections tmuxy does make:

| Connection               | When                                                 | How to turn it off                                   |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| The server listens       | While `tmuxy server` runs                            | Do not run it, or keep the loopback default          |
| Push notifications       | A device turned them on and a pane needs you         | Turn them off in View, or `set -g @tmuxy-notify off` |
| Remote preview resources | `tmuxy open --net` on a page that names remote hosts | Leave out `--net`                                    |
| SSH to a saved server    | You attach the desktop app to one                    | Remove it from your saved servers                    |
| Plugin index             | `tmuxy plugin install <name>` or `search`            | Install by `owner/repo` or `--path DIR`              |
| Plugin source            | `tmuxy plugin install` or `update`                   | Install from `--path DIR`                            |

The action trace is a local file and is off in release builds unless you turn it on. It holds action names and timings, not what you type or what programs print.

The website at tmuxy.sh is separate. It uses Google Analytics, and its demo runs a copy of tmuxy in your browser with no network. The full list is in the [telemetry doc](https://github.com/flplima/tmuxy/blob/main/docs/TELEMETRY.md).

## Hardening checklist

1. Keep the loopback default. Reach it by SSH tunnel or VPN.
2. If you must use a routable address, set `TMUXY_PASSWORD` and put TLS in front.
3. Never use `--no-auth` on a network others share.
4. Do not run tmuxy as root.
5. Close the raw `tmux` door in your agent's permissions, and allow `tmuxy` subcommands one by one.

Also worth doing:

- Keep sessions with SSH keys, credentials or production access apart from sessions an agent works in.
- Give agents the `?read-only` MCP URL when they only need to look.
- Read a plugin's install gate before you accept it.
- Use tmux 3.7a or newer if your build has Sixel.

## Report a vulnerability

Report it privately through a [GitHub security advisory](https://github.com/flplima/tmuxy/security/advisories/new). Please do not open a public issue, discussion or pull request before it is fixed.

Say what an attacker can do and from where, your tmuxy version (`tmuxy --version`), how it runs and the OS, and the steps to reproduce. A trace slice helps (`tmuxy trace --last 5`).

Access to a shell is not a vulnerability, since that is what tmuxy gives. A way past a check is: reaching a session without the credentials, a page or a file doing something you did not ask for, or a secret leaving the machine. The full policy is in [SECURITY.md](https://github.com/flplima/tmuxy/blob/main/SECURITY.md). Only the latest release is supported.

## See also

- [[Remote Access]]
- [[Send Permissions]]
- [[AI Agents]]
- [[Plugins]]
