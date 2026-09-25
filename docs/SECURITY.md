# Security

Tmuxy is a **development tool** that is **not production-ready**. It provides direct access to a user's tmux session, which means full shell access to the host machine. This document describes the security model, known risks, and mitigations.

## Development Status Warning

Tmuxy is under active development and has not undergone a security audit. It is designed for use on **trusted networks** (localhost, LAN, VPN) by a **single user**. Do not deploy it on untrusted networks without additional security layers.

## The First-Run Notice

The web app and the desktop app open with a notice saying what this document says at length: alpha software, written largely by AI agents, and — on the web — a remote control for a shell, with the three rules that follow from it (localhost or a tunnel, a password on any other address, never the internet). It is modal: the keyboard is kept from the panes while it is up, and focus starts on the dialog rather than its button, so someone already typing does not dismiss it with a space. _I understand_ closes it for that load; _Don't show this again_ remembers the answer in that browser's storage (`tmuxy-ui/src/utils/riskNotice.ts`). A read-only viewer is not shown it, and neither are the in-browser sandboxes (demo, v86), which have no shell behind them.

## Threat Model

Tmuxy assumes:

- **Single user** per deployment (no multi-tenant access control)
- **Trusted network** (localhost, LAN behind firewall, or VPN)
- **Server runs as the same user** who owns the tmux session
- **All clients of one server are equally trusted** (no per-client permissions) — a server is either writable by everyone it serves or, with `--read-only`, by no one (see [Read-Only Server](#read-only-server))

It does **not** assume the user's browser is trusted: the same browser that has tmuxy open visits other sites, and any of them can try to send requests to the tmuxy server. See [Cross-Origin Requests](#cross-origin-requests).

If any of these assumptions are violated, the risks described below apply.

## Where the Server Listens

`tmuxy server` listens on **127.0.0.1** by default: reachable from this machine only, and from anywhere an SSH tunnel brings that port. No password is needed there.

Any other `--host` (a LAN address, a VPN address, `0.0.0.0`) puts a shell on the network, so the server **refuses to start** unless one of these is given:

| Flag                               | Meaning                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--password …` or `TMUXY_PASSWORD` | Every route requires HTTP Basic auth (below)                                                                                                                                                                  |
| `--no-auth`                        | Serve it open. Only for a network where everyone who can reach the port may already run commands as you — a container's published port, a VPN with nobody else on it. The server prints a warning at startup. |

A `--host` that is not an IP address is an error; the server never falls back to listening on every interface. The routing and the startup check live in `tmuxy-server/src/server.rs`.

### Optional HTTP Basic Auth

For a barrier against unauthenticated access (e.g. a port scan reaching an exposed instance), start the server with a password:

```bash
TMUXY_PASSWORD='your-secret' tmuxy server --host 0.0.0.0  # env var keeps it out of `ps`
tmuxy server --host 0.0.0.0 --password 'your-secret'      # or on the command line
```

When a password is set, **every** route — the frontend, `/events` (SSE), `/commands`, and all `/api/*` endpoints — requires HTTP Basic auth. The browser shows a native login prompt on first load; enter **any username** and the configured password (only the password is checked). Once entered, the browser caches the credentials and attaches them automatically to the SSE stream and every request. The password is compared in constant time, and unauthenticated requests get a `401` with a `WWW-Authenticate` challenge.

A wrong password costs the peer time. The first few failures are free — someone at a browser prompt mistypes — and after that the refusal is held, doubling from one second to a cap of thirty, forgotten ten minutes after that peer stops trying; a correct password clears the count immediately. Every refusal is logged with the address it came from. The count is per peer IP, so **behind a reverse proxy the peer is the proxy** and the delay is shared by everyone behind it: the proxy is expected to do its own limiting, and `X-Forwarded-For` is deliberately not trusted here because anyone can send one.

Basic auth is **not** a substitute for TLS (#2) — over plain HTTP the credentials are base64, not encrypted; combine it with an SSH tunnel, VPN, or a TLS-terminating reverse proxy.

### Read-Only Server

`tmuxy server --read-only` (or `TMUXY_READ_ONLY=1`) serves viewers: every client receives the state stream and none can change the session. It is a property of the server process, not of a client or a URL, so there is nothing for a client to drop or forge. To share a session for watching, run a second server on its own port beside the one you write through (each port keeps its own pid file, so `tmuxy server --port N stop` stops the right one).

A read-only server is **pinned to one session** — `--session <name>` (or `TMUXY_SESSION`), defaulting to `tmuxy`. This matters because the recommended setup puts the viewer on the _same tmux socket_ as the writer, where every other session of yours is one name away: without the pin, a viewer naming any session in `?session=` was handed that session's screen.

What the server does in this mode, in `tmuxy-server/src/sse.rs` and `command.rs`:

- **Refuses every command that is not a read** with a 403, decided before dispatch from `ClientCommand::is_read` — state, scrollback, themes, git worktrees and trace settings are reads; everything else is not, including `query_tmux`, which carries an arbitrary tmux command that nothing here can classify.
- **Never records a client's viewport**, so a viewer's small window cannot resize the session under whoever is writing, and its monitor attaches without the initial resize (`MonitorConfig::observer`).
- **Refuses `/trace`** and announces the mode in the `connection-info` greeting, which is how the frontend knows to stop offering changes.
- **Serves fewer open event streams.** A viewer's server is the one whose address gets handed around, so it holds a tighter budget than the one its owner writes through: each `/events` stream is a long-lived task, and past the cap a new one answers 503 rather than being accepted.
- **Serves one session and creates none.** A name other than the pinned one answers 404, and so does the pinned one before it exists — a viewer's server attaches to a session or it does not run, where it used to answer every invented name with `new-session -A`, spawning a live shell per name that outlived the viewer. Pane ids in a scrollback request are resolved against that session's own panes before `capture-pane` sees them, and worktree discovery lists only that session's panes.
- **Refuses `/api/file` and `/api/browse`** with a 403. "Read-only" is about the session, and those two routes are a different power: they read any file the server process can, anywhere on the disk. A read-only server is the one meant to be handed to people who are not trusted with the machine, so the arbitrary-read routes are exactly the ones it must not serve. Only the browser widget uses them, and opening one takes a command a viewer cannot send.

What it does not do: it is not confidentiality _within the session it shows_. A viewer reads everything on screen and in scrollback — which is everything the session has printed, including anything a command echoed. The server's own monitor also still applies tmuxy's session options and window tags when it attaches — idempotent next to a writing tmuxy, but not nothing on a session tmuxy has never managed. Pair it with a password and TLS like any other exposed server, and for a genuinely public viewer see [A Public Read-Only Viewer](#a-public-read-only-viewer).

### Behind a Reverse Proxy

A proxy on the same machine forwards to `127.0.0.1`, but it usually passes its public name through as the `Host` header, which the server does not recognise as itself (see below). Name it: `tmuxy server --allowed-host tmux.example.com` (repeatable, or `TMUXY_ALLOWED_HOSTS` comma-separated).

Forgetting it is easy to diagnose: the page itself still loads (static files are not guarded), every API route answers 403, and the app says so — _The server refused this page: request Host is not this server (see --allowed-host)_ — instead of waiting on a connection that cannot open (see `explainRefusal` in `tmuxy-ui/src/tmux/HttpAdapter.ts`).

### Tauri Desktop App

The desktop app serves no HTTP: all communication is local IPC within the app process. Its webview currently runs with no Content-Security-Policy (`csp: null` in `tmuxy-tauri-app/tauri.conf.json`).

## Cross-Origin Requests

The API is a remote shell, and a browser sends requests on behalf of whatever page is open in it. A site the user visits can POST to `http://localhost:9000/commands` without a CORS preflight (a `text/plain` body is enough), and a site whose domain is re-pointed at 127.0.0.1 (DNS rebinding) looks same-origin to the browser. So every API route checks where a request came from before any handler runs (`tmuxy-server/src/request_guard.rs`):

| Header                      | Rule                                                                 | Stops                                                                      |
| --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Sec-Fetch-Site`            | Must be `same-origin` (the app) or `none` (typed in the address bar) | Any other origin, including another port on localhost and a sandboxed page |
| `Origin`                    | Must name the host the request was sent to                           | The same, in a browser without Fetch Metadata                              |
| `Host`                      | Must be a loopback name, the address the server bound, or an `--allowed-host` | DNS rebinding                                                     |

The API sends **no CORS headers**, so no other origin can read a response even when a request is let through. A request with none of these headers is not a browser acting for a page (`curl`, a script) and is allowed. Cached Basic-auth credentials do not help a hostile page: its requests are refused by origin before the password matters.

The `Host` rule applies to a routable bind too: the address it bound is a name it answers to, and so is anything passed with `--allowed-host` (repeatable, or `TMUXY_ALLOWED_HOSTS`). The one gap left is a **wildcard** bind (`0.0.0.0`, `::`) given no allowed list, where the server genuinely does not know which of its addresses a request arrived on and any `Host` passes — the container case, where the published port is the boundary. Naming the host you reach it by closes that too.

## Local Files Are Served Sandboxed

`/api/file` and `/api/browse` read any file the server process can read, with a real content type, so an HTML file would render with the server's own origin and could use the API like the app does. Both routes answer with `Content-Security-Policy: sandbox` (without `allow-same-origin`), so the document runs in an opaque origin of its own whether the browser widget frames it or someone opens its URL. The browser widget also frames every local page with the `sandbox` attribute, which covers the desktop app's `tmuxyfile:` scheme too (`tmuxy-ui/src/components/widgets/browser/TmuxyBrowser.tsx`).

The desktop webview carries its own `Content-Security-Policy` (`tauri.conf.json`). It is defence in depth rather than a boundary — an XSS from pane output would run with the Tauri IPC behind it, which is `open_url`, the file schemes and CLI exec, so it is worth more here than on the web. The policy names each scheme the app actually loads from (`tauri:`, `asset:`, `tmuxyfile:`, `tmuxyimg:`, and their `http://<scheme>.localhost` forms on Windows) and keeps `frame-src *`, which is the browser widget's whole purpose. **Adding a resource the app loads means adding it here too** — a CSP refuses quietly, and the symptom is a picture or a page that simply does not appear.

The cost: a local page cannot use cookies or storage, and a link followed inside it is invisible to the widget. A website is another origin already, so it keeps `allow-same-origin` (its logins and storage work) but is still sandboxed — without `allow-top-navigation`, so a framed page cannot set `window.top.location` and navigate the whole tmuxy tab away, which would be a convincing place to phish the Basic-auth prompt.

## Input That Reaches Control Mode

Control mode reads one command per line, so a newline inside anything written into a command line would end that command and start another.

- **Session names** from `/events?session=` and `/commands?session=` are refused with `400` when empty or containing a control character, and are quoted wherever the server builds a command from one (`tmuxy-server/src/sse.rs`).
- **Literal text** — a paste, an IME composition, the selection menu's _Send keys_ — is typed one line at a time, one `send-keys -l` per line with `Enter` between them (`literalTextCommands` in `tmuxy-ui/src/tmux/keyBatching.ts`). Multi-line text pasted into a shell still runs as commands in that shell, exactly as in any terminal.

## Pane Output Threat Model

Bytes emitted by any command running in a pane reach parsers, image decoders, and link handlers in a browser or webview context. Unlike commands entered by the user, terminal output is frequently untrusted: displaying a file (`cat untrusted.txt`), running a test suite, fetching logs, or inspecting untrusted git repositories can output arbitrary byte streams to stdout or stderr.

### The Pipeline

```
+----------------+      +-------------+      +----------------+      +-----------------+
| Program in     | ---> | tmux Server | ---> | tmuxy Server   | ---> | Frontend Web/   |
| Pane (stdout)  |      | (%output)   |      | (core stream)  |      | Desktop Webview |
+----------------+      +-------------+      +----------------+      +-----------------+
  Untrusted bytes        Control mode         Deltas / SSE           Parsers, decoders,
                                                                     DOM & Canvas render
```

### Trust Boundaries

| Component                      | Trust Level          | Rationale                                                                                 |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------- |
| The host machine & tmux server | Trusted              | Runs with the authenticated user's permissions                                            |
| The tmuxy backend server       | Trusted              | Local process mediating control-mode and state                                            |
| Pane output byte streams       | **Untrusted**        | Any program or untrusted input file can write arbitrary escape sequences or payload bytes |
| Browser / Webview environment  | Semi-trusted context | Has access to DOM, clipboard APIs, web workers, and backend API routes                    |

### Threat Vectors

1. **DOM Injection & Cross-Site Scripting (XSS)**
   - _Vector:_ Escape sequences or text runs attempting to inject HTML/SVG tags or execute script via DOM rendering.
   - _Policy:_ Terminal text must render as plain text nodes or canvas ink, never via unescaped `innerHTML`. Dynamic titles, tab labels, and pane annotations originating from terminal output must be escaped or treated as text content.

2. **Unsafe Hyperlinks (OSC 8 & Linkifiers)**
   - _Vector:_ Explicit OSC 8 hyperlinks (`\e]8;;<URL>\e\\`) or implicit URL regex linkifiers matching dangerous schemes (e.g. `javascript:`, `data:`, `file:`, `blob:`).
   - _Policy:_ URLs must pass an explicit allowlist of safe schemes (`http:`, `https:`, `mailto:`, `git:`). Any URL using a prohibited or unknown scheme must either be stripped or rendered as plain, unclickable text. Clicks must open in a new context with `rel="noopener noreferrer"`.

3. **Image Decoder Exploits & Memory Exhaustion**
   - _Vector:_ Protocols supporting embedded graphics (OSC 1337 iTerm2 images, Kitty graphics protocol, Sixel) transmitting malformed base64 payloads, decompression bombs, or extreme dimensions (e.g. 65535x65535 canvas).
   - _Policy:_ Image dimensions and payload byte sizes must be strictly bounded before memory allocation or canvas creation (see [RICH-RENDERING.md](RICH-RENDERING.md)). Image decoding must occur in isolated sandboxes or off-thread decoders, and invalid image headers must fail fast without consuming excessive CPU or memory.

4. **Clipboard Poisoning (OSC 52)**
   - _Vector:_ A program writing malicious shell commands to the system clipboard via OSC 52, tricking the user into pasting and executing dangerous commands.
   - _Policy:_ OSC 52 clipboard writes obey bounds rather than a prompt — a confirmation on every yank would break the legitimate use (nvim or tmux yanking over ssh, which is the reason the sequence is honoured at all) and train the user to click through it. The bounds: only the **active pane** may write, so a tailed log or a stray ssh session cannot replace what the user is about to paste; the decoded payload is capped (`MAX_CLIPBOARD_BYTES`); and every accepted write announces itself on the status line, naming the pane and the size, so a clipboard the user did not set is never silent. tmux paste buffers, which are global to the tmux server, are mirrored only when a pane of _this_ session is in copy mode, and never on a `--read-only` server. The server or client must never allow unauthorized background clipboard reads.

5. **ReDoS & Parser Desynchronization**
   - _Vector:_ Pathological escape sequences designed to trigger exponential regex backtracking in parsers or desynchronize the terminal state machine.
   - _Policy:_ All sequence parsers and URL detectors must guarantee linear-time parsing. Malformed or truncated sequences must be discarded cleanly without locking the main rendering thread.

### What Fuzz Tests Must Guarantee

Automated fuzzing over terminal parsers and sequence handlers must verify:

- **No Panics or Unhandled Exceptions:** The Rust aggregator (`tmuxy-core`) and frontend terminal stream consumers must never panic, throw unhandled exceptions, or crash when fed completely random or adversarial byte streams.
- **Strict Scheme Filtering:** Fuzzing URI inputs against OSC 8 handlers and regex linkifiers must never emit an `<a>` tag with an href containing `javascript:`, `vbscript:`, or unvetted pseudo-protocols.
- **Bounded Resource Consumption:** Feeding arbitrarily large or invalid base64 image chunks must terminate within bounded memory and time budgets.
- **Parser Resynchronization:** An incomplete, nested, or corrupt escape sequence must not corrupt subsequent valid output lines or state updates.

## Known Risks

### 1. Remote Access When Exposed (High)

**Risk:** A server reachable from other machines gives whoever reaches it full control over the tmux session.

**Impact:** Arbitrary command execution on the host machine via `run-shell` commands or by typing into any pane.

**Mitigation:**

- The default listens on 127.0.0.1 only, and a routable address needs a password or an explicit `--no-auth` ([Where the Server Listens](#where-the-server-listens))
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

### 4. Unrestricted File Access (High)

**Risk:** The `/api/file` and `/api/browse` endpoints read arbitrary files, with no path restrictions beyond Unix file permissions.

**Impact:** Information disclosure to any allowed client — SSH keys, configuration files, source code, credentials, and any file readable by the server process. Other origins are refused ([Cross-Origin Requests](#cross-origin-requests)) and a served page is sandboxed ([Local Files Are Served Sandboxed](#local-files-are-served-sandboxed)).

**Mitigation:** The server should run as an unprivileged user. Do not run tmuxy as root. A `--read-only` server refuses both routes outright ([Read-Only Server](#read-only-server)), which is what makes a viewer safe to hand to someone who is not trusted with the machine.

### 5. `--no-auth` on a Routable Address (Medium)

**Risk:** Everyone on the network can reach the server with no password.

**Impact:** Anyone on the network gets shell access.

**Mitigation:** Use a password instead, or listen on 127.0.0.1 and tunnel. Keep `--no-auth` to an isolated network such as a container's published port on a single-user machine. DNS rebinding on top of this is now refused by the `Host` check unless the bind is a wildcard with no `--allowed-host` ([Cross-Origin Requests](#cross-origin-requests)); naming the host closes that case.

### 6. Browsers Without Fetch Metadata (Low)

**Risk:** A browser that sends neither `Sec-Fetch-Site` nor `Origin` on a simple `GET` (old releases) lets a hostile page trigger `GET` routes — open an event stream, request a file.

**Impact:** The page cannot read any response (no CORS headers), and a session name that would inject a command is refused. The requests themselves still reach the server.

### 7. No Audit Logging (Medium)

**Risk:** No logging of commands executed, sessions created, or clients connected. Requests refused by the origin check are logged as warnings.

**Impact:** No forensic trail if unauthorized access occurs.

## LLM-Assisted Development Risks

When using AI coding assistants (Claude, Copilot, etc.) with tmuxy running:

### The AI Has Your tmux Session

If an AI agent has access to the machine where tmuxy is running, it can interact with your tmux sessions. This includes:

- Reading terminal output from all panes
- Sending keystrokes to any pane
- Running shell commands via `run-shell`
- Creating/destroying windows and panes

### Prompt Injection via Terminal Output

Terminal output from running processes could contain text that looks like instructions to an AI agent. If the agent reads pane content and acts on it, malicious programs could manipulate the agent's behavior. This is a general risk of AI agents interacting with untrusted output.

### Recommendations for AI-Assisted Development

- Review AI-generated commands before they execute in tmux
- Use separate tmux sessions for sensitive work (SSH keys, credentials, production systems)
- Be cautious about AI agents that have both tmuxy access and internet access
- Monitor what commands the AI sends through the tmuxy interface

## Deployment Recommendations

### Local Development (Lowest Risk)

```
Developer → Tauri Desktop App → local tmux
```

No network exposure. Use the Tauri app for local development — it communicates via in-process IPC only.

### Remote Access via SSH Tunnel (Recommended)

```
Developer → SSH tunnel → localhost:9000 → tmuxy server → tmux
```

1. Run `tmuxy server` on the remote machine (it listens on 127.0.0.1)
2. From your local machine: `ssh -L 9000:localhost:9000 user@remote`
3. Open `http://localhost:9000` in your browser

SSH provides authentication, encryption, and access control. This is the recommended approach for single-user remote access.

### Remote Access via VPN (Recommended for Mobile)

```
Mobile/Laptop → VPN (WireGuard/Tailscale) → tmuxy server → tmux
```

1. Set up a VPN between your devices and the remote machine
2. Run `TMUXY_PASSWORD=… tmuxy server --host <vpn address>` on the remote machine
3. Access via the VPN IP address

This is the recommended approach for mobile access where SSH tunnels are impractical.

### Remote Access via Reverse Proxy (Alternative)

```
Browser → HTTPS → nginx/Caddy (+ auth) → HTTP → tmuxy server → tmux
```

1. Run `tmuxy server --allowed-host <public name>` on the server
2. Configure nginx or Caddy with:
   - TLS certificate (Let's Encrypt or self-signed)
   - Authentication (basic auth, OAuth, client certificates)
   - Proxy pass to `http://127.0.0.1:9000`
   - SSE support enabled (no response buffering)

### What NOT to Do

- **Do NOT** expose tmuxy directly on a public IP
- **Do NOT** pass `--no-auth` on a network other people share
- **Do NOT** run tmuxy as root
- **Do NOT** use tmuxy on shared/multi-tenant servers without network isolation
- **Do NOT** store secrets (API keys, passwords, SSH passphrases) in tmux sessions that are connected to tmuxy on a network

## Future Security Improvements

Implemented:

- **Loopback by default** — a routable address needs a password or `--no-auth`
- **Optional HTTP Basic auth** — `--password` / `TMUXY_PASSWORD` gates every route
- **Cross-origin guard** — Fetch Metadata, `Origin` and `Host` checks on every API route; no CORS headers
- **Sandboxed file routes** — served HTML never runs with the server's origin
- **Read-only server** — `--read-only` serves viewers that cannot send input, run commands or resize the session

Not yet implemented, but would improve the security posture:

- **Bearer token auth** — token-based auth as an alternative to Basic
- **TLS support** — Built-in HTTPS with certificate configuration
- **Command allowlisting** — Restrict which tmux commands clients can execute
- **Per-client permissions** — writers and viewers on one server, instead of one server per role
- **Audit logging** — Log all commands and client connections
- **Path restrictions** — Limit `/api/file` and `/api/browse` to specific directories
- **Rate limiting** — command flooding (failed passwords are already rate-limited, see [Optional Password](#optional-password))

## Related

- [DATA-FLOW.md](DATA-FLOW.md) — Deployment scenarios with security guidance for each
- [TMUX.md](TMUX.md) — Control mode constraints (commands that must go through control mode)
