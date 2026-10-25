# Security

Tmuxy is a **development tool** that is **not production-ready**. It provides direct access to a user's tmux session, which means full shell access to the host machine. This document describes the security model, known risks, and mitigations.

## Development Status Warning

Tmuxy is under active development and has not undergone a security audit. It is designed for use on **trusted networks** (localhost, LAN, VPN) by a **single user**. Do not deploy it on untrusted networks without additional security layers.

## Threat Model

Tmuxy assumes:

- **Single user** per deployment (no multi-tenant access control)
- **Trusted network** (localhost, LAN behind firewall, or VPN)
- **Server runs as the same user** who owns the tmux session
- **All clients of one server are equally trusted** (no per-client permissions) — a server is writable by everyone it serves

It does **not** assume the user's browser is trusted: the same browser that has tmuxy open visits other sites, and any of them can try to send requests to the tmuxy server. See [Cross-Origin Requests](SECURITY-NETWORK.md#cross-origin-requests).

If any of these assumptions are violated, the risks described below apply.

See [SECURITY-NETWORK.md](SECURITY-NETWORK.md) for these sections: Where the Server Listens; Cross-Origin Requests; What the App Will Load and Draw; Deployment Recommendations.

See [SECURITY-CONTENT.md](SECURITY-CONTENT.md) for these sections: A Preview Reads One File; A Session Snapshot Is a Record of the Machine; Pane Output Threat Model.

## Input That Reaches Control Mode

Control mode reads one command per line, so a newline inside anything written into a command line would end that command and start another.

- **Session names** from `/events?session=` and `/commands?session=` are held to letters, digits and `_ - @ +` (`tmuxy_core::session::is_safe_session_name`) and refused with `400` otherwise. The name goes into control-mode command lines and into `run-shell` strings that tmux format-expands before a shell sees them; an alphabet nothing in those contexts can misread replaces escaping for each. A `--session` pin outside it is refused at startup, since no client could name it. Every name tmuxy creates fits, and tmux itself forbids `.` and `:`.
- **Pane ids** a client sends (`get_scrollback_cells`) must parse as tmux's canonical `%<digits>` (`tmuxy_core::ids::PaneId`) before they are used as a `-t` target; a client only ever learned ids from `list-panes`, so `other:0.0` or `{last}` is not a pane it was shown.
- **Literal text** — an IME composition, the selection menu's _Send keys_ — is typed one line at a time, one `send-keys -l` per line with `Enter` between them (`literalTextCommands` in `tmuxy-ui/src/infra/transport/keyBatching.ts`).
- **A paste** is staged in a named tmux buffer and delivered with `paste-buffer -p` (`pastedText` in `tmuxy-ui/src/domain/commandHelpers.ts`). The text travels as a double-quoted string in which every newline, quote, `\`, `$`, `~`, `;` and `#{` is an octal escape, so no part of it can end the command line or be read as tmux syntax, and any bracketed-paste markers in it are removed, so it cannot close the paste early. A program that turned bracketed paste on receives the text as one paste; into a shell that did not, it still runs line by line, exactly as in any terminal. In a window with `synchronize-panes` on, the paste goes to every synchronized pane, as typed input does (`packages/tmuxy-cli/bin/tmuxy/paste-synced`); only a pane id is ever put on that script's command line, never the session name a paste can fall back to.

## Known Risks

### 1. Remote Access When Exposed (High)

**Risk:** A server reachable from other machines gives whoever reaches it full control over the tmux session.

**Impact:** Arbitrary command execution on the host machine via `run-shell` commands or by typing into any pane.

**Mitigation:**

- The default listens on 127.0.0.1 only, and a routable address needs a password or an explicit `--no-auth` ([Where the Server Listens](SECURITY-NETWORK.md#where-the-server-listens))
- **Never expose tmuxy directly to the internet**
- Use an SSH tunnel: `ssh -L 9000:localhost:9000 user@server`
- Use a VPN: WireGuard, Tailscale, or similar
- Use a reverse proxy with authentication (nginx + basic auth, Caddy + OAuth)

### 2. No TLS/HTTPS (High)

**Risk:** All communication is over plain HTTP. Terminal content and commands are transmitted in cleartext.

**Impact:** Network eavesdropping can observe all terminal output and see all keystrokes sent to tmux. An observer on-path can also capture Basic-auth credentials and inject commands.

**Mitigation:**

- Use a reverse proxy (nginx, Caddy) with TLS certificates for HTTPS
- For LAN use, self-signed certificates are acceptable
- SSH tunnels provide encryption by default

### 3. Arbitrary Command Execution (High)

**Risk:** Any client allowed through can send any tmux command, including `run-shell` which executes arbitrary shell commands within the tmux server process.

**Impact:** Full shell access as the user running the tmux server. Can read/write files, start processes, modify system state.

**Context:** This is by design — tmuxy is a tmux UI, and tmux provides full shell access. Reaching the server as an allowed client is sufficient for code execution.

What the server does _not_ do is interpolate a client's command into a shell of its own: every command goes down the monitor's control-mode connection as a tmux command line, reads included, so there is no `sh -c` for shell metacharacters to escape from.

### 4. `--no-auth` on a Routable Address (Medium)

**Risk:** Everyone on the network can reach the server with no password.

**Impact:** Anyone on the network gets shell access.

**Mitigation:** Use a password instead, or listen on 127.0.0.1 and tunnel. Keep `--no-auth` to an isolated network such as a container's published port on a single-user machine. DNS rebinding on top of this is now refused by the `Host` check unless the bind is a wildcard with no `--allowed-host` ([Cross-Origin Requests](SECURITY-NETWORK.md#cross-origin-requests)); naming the host closes that case.

### 5. Browsers Without Fetch Metadata (Low)

**Risk:** A browser that sends neither `Sec-Fetch-Site` nor `Origin` on a simple `GET` (old releases) lets a hostile page trigger `GET` routes — open an event stream, request a picture.

**Impact:** The page cannot read any response (no CORS headers), and a session name that would inject a command is refused. The requests themselves still reach the server.

### 6. No Audit Logging (Medium)

**Risk:** No logging of commands executed, sessions created, or clients connected. Requests refused by the origin check are logged as warnings.

**Impact:** No forensic trail if unauthorized access occurs.

## LLM-Assisted Development Risks

When using AI coding assistants (Claude, Copilot, etc.) with tmuxy running:

### The AI Has Your tmux Session

If an AI agent has access to the machine where tmuxy is running, it can interact with your tmux sessions. This includes:

- Reading terminal output from all panes
- Sending keystrokes to any pane (`tmuxy pane send -t` into a pane that is not the caller's asks the user there first, unless `@tmuxy-send-ask` is off or the caller is on `@tmuxy-send-allow`)
- Running shell commands via `run-shell`
- Creating/destroying windows and panes

### Prompt Injection via Terminal Output

Terminal output from running processes could contain text that looks like instructions to an AI agent. If the agent reads pane content and acts on it, malicious programs could manipulate the agent's behavior. This is a general risk of AI agents interacting with untrusted output.

### Agents the Repository Starts Itself

The weekly `sunday sweep` workflow (`bin/ci/sunday-sweep.mjs`) hands open high and critical Dependabot and CodeQL alerts, and Dependabot PRs whose checks fail, to the Copilot cloud agent. It runs on a fine-grained token, `COPILOT_AGENT_PAT`, scoped to this repository alone: metadata, Dependabot alerts and code scanning alerts read; contents, issues and pull requests read/write; agent tasks write. `GITHUB_TOKEN` can neither read Dependabot alerts nor start the agent. The token is used by that scheduled job only, never by a workflow a pull request can trigger, so a fork or a Dependabot PR cannot reach it.

Alert text and CI logs are other people's words, and they become part of the agent's prompt: an advisory summary or a failing log could carry instructions. The sweep fences that text as data and caps how much of it is passed. The real safeguard is that the agent's PRs are drafts whose workflows wait for a maintainer's "Approve and run": nothing the agent writes runs in CI, or reaches main, without a person reading it first. Keep that setting on. At most three tasks start per run, so a flood of alerts cannot run up the agent's cost unattended.

`dependabot actions merge` merges Dependabot's bumps of the workflows' own actions once `lint and tests` is green on them, and nothing else. It runs on `workflow_run`, in this repository's context, and never checks the PR's code out. npm and cargo bumps stay manual.

### Recommendations for AI-Assisted Development

- Review AI-generated commands before they execute in tmux
- Use separate tmux sessions for sensitive work (SSH keys, credentials, production systems)
- Be cautious about AI agents that have both tmuxy access and internet access
- Monitor what commands the AI sends through the tmuxy interface

## Future Security Improvements

Implemented:

- **Loopback by default** — a routable address needs a password or `--no-auth`
- **Optional HTTP Basic auth** — `--password` / `TMUXY_PASSWORD` gates every route
- **Cross-origin guard** — Fetch Metadata, `Origin` and `Host` checks on every API route; no CORS headers

Not yet implemented, but would improve the security posture:

- **Bearer token auth** — token-based auth as an alternative to Basic
- **TLS support** — Built-in HTTPS with certificate configuration
- **Command allowlisting** — Restrict which tmux commands clients can execute
- **Per-client permissions** — different rights for different clients of one server
- **Audit logging** — Log all commands and client connections
- **Rate limiting** — command flooding (failed passwords are already rate-limited, see [Optional HTTP Basic Auth](SECURITY-NETWORK.md#optional-http-basic-auth))

## Related

- [DATA-FLOW.md](DATA-FLOW.md) — Deployment scenarios with security guidance for each
- [TMUX.md](TMUX.md) — Control mode constraints (commands that must go through control mode)
