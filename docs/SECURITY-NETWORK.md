# Security: Network Exposure

Where the server listens, what it serves, and how to deploy it. Part of [SECURITY.md](SECURITY.md).

## Where the Server Listens

`tmuxy server` listens on **127.0.0.1** by default: reachable from this machine only, and from anywhere an SSH tunnel brings that port. No password is needed there.

Any other `--host` (a LAN address, a VPN address, `0.0.0.0`) puts a shell on the network, so the server **refuses to start** unless one of these is given:

| Flag | Meaning |
| --- | --- |
| `--password …` or `TMUXY_PASSWORD` | Every route requires HTTP Basic auth (below) |
| `--no-auth` | Serve it open. Only for a network where everyone who can reach the port may already run commands as you — a container's published port, a VPN with nobody else on it. The server prints a warning at startup. |

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

A viewer is answered from the session it watches and nothing else: the trace settings (which name the trace file under the server's home) are refused, and the sidebar's repository list is empty rather than the working directory of every pane on the socket, so a viewer's request never runs `git` on the host.

A read-only server is **pinned to one session** — `--session <name>` (or `TMUXY_SESSION`), defaulting to `tmuxy`. This matters because the recommended setup puts the viewer on the _same tmux socket_ as the writer, where every other session of yours is one name away: without the pin, a viewer naming any session in `?session=` was handed that session's screen.

A read-only server is a different shape, not the writable server with a filter: it builds a smaller router (`viewer_routes` in `tmuxy-server/src/state.rs`) and owns **one monitor for its whole life**, started before it listens (`start_viewer_monitor` in `sse.rs`). That monitor attaches to the pinned session when it exists, waits and looks again when it does not, and re-attaches when a killed session is re-made; it is never created by a viewer, held open by one, or shut down when the last one leaves. Viewers subscribe to its broadcast and are told "nothing to show" (404) while it is not attached.

What the server does in this mode, in `tmuxy-server/src/sse.rs` and `command.rs`:

- **Has its own, total dispatch.** `serve_viewer` in `tmuxy-server/src/sse.rs` names every command a viewer is served — the initial state, scrollback, the theme settings, the themes list, the worktree list — and refuses everything else with a 403. The writable implementation is never reached on this server at all. Refusal is what an unlisted command gets, so a variant added later is viewer-safe until someone writes down how a viewer should be served it; `query_tmux`, which carries an arbitrary tmux command nothing here can classify, is simply not on the list. The role lives in that one match rather than in a branch per call site, which is what used to let the two drift.
- **Never records a client's viewport**, so a viewer's small window cannot resize the session under whoever is writing, and its monitor attaches without the initial resize (`MonitorConfig::observer`).
- **Costs the writer's session nothing.** A connect reads no `has-session` (the monitor's own state says whether the session is attached); the key bindings and the theme settings are each read once per server, not once per request. A scrollback request touches tmux not at all: an observer's monitor keeps its own bounded history per pane (`VIEWER_SCROLLBACK_ROWS`) as output flows past, and the request is answered from that grid. The pane must be one the monitor holds, which is the session it was pinned to, so a viewer cannot name a pane it was never shown; one response is capped at 5000 rows (`MAX_VIEWER_SCROLLBACK_ROWS`).

  The trade is deliberate: a viewer sees the history its own monitor witnessed, not tmux's full backlog, and nothing from before it attached. Scrolling a viewer is therefore never work charged to the session being watched — which matters most exactly when the viewer is untrusted or numerous.

- **Announces the mode** in the `connection-info` greeting, which is how the frontend knows to stop offering changes.
- **Serves fewer open event streams.** A viewer's server is the one whose address gets handed around, so it holds a tighter budget than the one its owner writes through: each `/events` stream is a long-lived task, and past the cap a new one answers 503 rather than being accepted.
- **Serves one session and creates none.** A name other than the pinned one answers 404, and so does the pinned one while it does not exist — the server's monitor waits for it, where the old shape answered every invented name with `new-session -A`, spawning a live shell per name that outlived the viewer.
- **Has no `/trace`.** "Read-only" is about the session, and that route is a different power: it writes to the disk. A read-only server is the one meant to be handed to people who are not trusted with the machine, so the route is not built into its router at all (it answers 404, as any unknown path does).
- **Shows no previews.** A `preview` pane reads a file from the server's disk (`read_preview`, `/api/preview/{pane}`), and a viewer is shown the session's screen, not its files: the command is not on `serve_viewer`'s list and the route is not built, and the viewer's pane says the preview is not shared.

What it does not do: it is not confidentiality _within the session it shows_. A viewer reads everything on screen and in scrollback — which is everything the session has printed, including anything a command echoed. The server's own monitor also still applies tmuxy's session options and window tags when it attaches — idempotent next to a writing tmuxy, but not nothing on a session tmuxy has never managed. Pair it with a password and TLS like any other exposed server.

### Behind a Reverse Proxy

A proxy on the same machine forwards to `127.0.0.1`, but it usually passes its public name through as the `Host` header, which the server does not recognise as itself (see below). Name it: `tmuxy server --allowed-host tmux.example.com` (repeatable, or `TMUXY_ALLOWED_HOSTS` comma-separated).

Forgetting it is easy to diagnose: the page itself still loads (static files are not guarded), every API route answers 403, and the app says so — _The server refused this page: request Host is not this server (see --allowed-host)_ — instead of waiting on a connection that cannot open (see `explainRefusal` in `tmuxy-ui/src/infra/transport/drivers/HttpAdapter.ts`).

### Tauri Desktop App

The desktop app serves no HTTP: all communication is local IPC within the app process. Its webview runs under a Content-Security-Policy (see [What the App Will Load and Draw](#what-the-app-will-load-and-draw)).

## Cross-Origin Requests

The API is a remote shell, and a browser sends requests on behalf of whatever page is open in it. A site the user visits can POST to `http://localhost:9000/commands` without a CORS preflight (a `text/plain` body is enough), and a site whose domain is re-pointed at 127.0.0.1 (DNS rebinding) looks same-origin to the browser. So every API route checks where a request came from before any handler runs (`tmuxy-server/src/request_guard.rs`):

| Header | Rule | Stops |
| --- | --- | --- |
| `Sec-Fetch-Site` | Must be `same-origin` (the app) or `none` (typed in the address bar) | Any other origin, including another port on localhost and a sandboxed page |
| `Origin` | Must name the host the request was sent to | The same, in a browser without Fetch Metadata |
| `Host` | Must be a loopback name, the address the server bound, or an `--allowed-host` | DNS rebinding |

The API sends **no CORS headers**, so no other origin can read a response even when a request is let through. A request with none of these headers is not a browser acting for a page (`curl`, a script) and is allowed. Cached Basic-auth credentials do not help a hostile page: its requests are refused by origin before the password matters.

The `Host` rule applies to a routable bind too: the address it bound is a name it answers to, and so is anything passed with `--allowed-host` (repeatable, or `TMUXY_ALLOWED_HOSTS`). The one gap left is a **wildcard** bind (`0.0.0.0`, `::`) given no allowed list, where the server genuinely does not know which of its addresses a request arrived on and any `Host` passes — the container case, where the published port is the boundary. Naming the host you reach it by closes that too.

## What the App Will Load and Draw

The desktop webview carries its own `Content-Security-Policy` (`tauri.conf.json`). It is defence in depth rather than a boundary — an XSS from pane output would run with the Tauri IPC behind it, which is `open_url`, the app's schemes and CLI exec, so it is worth more here than on the web. The policy names each scheme the app actually loads from (`tauri:`, `asset:`, `tmuxyimg:`, `tmuxycss:`, and their `http://<scheme>.localhost` forms on Windows), and its `frame-src` names one: `tmuxypreview:`, the page a `preview` pane frames, which is served under its own sandboxing policy (see [A Preview Reads One File](SECURITY-CONTENT.md#a-preview-reads-one-file)). The app frames nothing else. **Adding a resource the app loads means adding it here too** — a CSP refuses quietly, and the symptom is a picture that simply does not appear.

Which pane is a widget at all is not decided by pane content. The `__TMUXY_WIDGET__:<name>` marker is output, so anything a pane prints could otherwise replace it with app UI the user never asked for: the client renders a widget only when the pane also carries `@tmuxy-pane-widget` naming it, which `tmuxy-widget` writes out of band and clears on exit (see [docs/TMUX.md](TMUX.md)).

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
