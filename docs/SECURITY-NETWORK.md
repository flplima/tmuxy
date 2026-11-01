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

A wrong password costs the peer time. The first few failures are free — someone at a browser prompt mistypes — and after that the refusal is held, doubling from one second to a cap of thirty, forgotten ten minutes after that peer stops trying; a correct password clears the count immediately. Only a request that carries an `Authorization` header counts: the bare first request that gets the prompt tests no password, and counting it would let any page open popups at the server until the user's own prompt was held back. Every refusal is logged with the address it came from. The count is per peer IP (per `/64` for IPv6, where one host holds a whole prefix), so **behind a reverse proxy the peer is the proxy** and the delay is shared by everyone behind it: the proxy is expected to do its own limiting, and `X-Forwarded-For` is deliberately not trusted here because anyone can send one.

Basic auth is **not** a substitute for TLS (#2) — over plain HTTP the credentials are base64, not encrypted; combine it with an SSH tunnel, VPN, or a TLS-terminating reverse proxy.

### Behind a Reverse Proxy

A proxy on the same machine forwards to `127.0.0.1`, but it usually passes its public name through as the `Host` header, which the server does not recognise as itself (see below). Name it: `tmuxy server --allowed-host tmux.example.com` (repeatable, or `TMUXY_ALLOWED_HOSTS` comma-separated).

Forgetting it is easy to diagnose: the page itself still loads (static files are not guarded), every API route answers 403, and the app says so — _The server refused this page: request Host is not this server (see --allowed-host)_ — instead of waiting on a connection that cannot open (see `explainRefusal` in `tmuxy-ui/src/infra/transport/drivers/HttpAdapter.ts`).

### Tauri Desktop App

The desktop app serves no HTTP: all communication is local IPC within the app process. Its webview runs under a Content-Security-Policy (see [What the App Will Load and Draw](#what-the-app-will-load-and-draw)).

## Cross-Origin Requests

The API is a remote shell, and a browser sends requests on behalf of whatever page is open in it. A site the user visits can POST to `http://localhost:9000/commands` without a CORS preflight (a `text/plain` body is enough), and a site whose domain is re-pointed at 127.0.0.1 (DNS rebinding) looks same-origin to the browser. So every API route checks where a request came from before any handler runs (`tmuxy-server/src/request_guard.rs`):

| Header | Rule | Stops |
| --- | --- | --- |
| `Sec-Fetch-Site` | Must be `same-origin` (the app) or `none` (typed in the address bar); `none`, or a `Sec-Fetch-Mode: navigate`, only on a `GET` | Any other origin, including another port on localhost and a sandboxed page |
| `Origin` | Must name the scheme and host the request was sent to (a default port matches its absence only for its own scheme) | The same, in a browser without Fetch Metadata |
| `Host` | Must be a loopback name, the address the server bound (any IP literal, for a wildcard bind), or an `--allowed-host`; an HTTP/2 `:authority` stands in for a missing `Host` and must agree with one that is sent | DNS rebinding |

Any of these sent twice, or with bytes that are not ASCII, is refused rather than read as absent. `POST /commands` and `POST /trace` also take only a `Content-Type: application/json` body, which no form and no preflight-free `fetch` can send.

The API sends **no CORS headers**, so no other origin can read a response even when a request is let through. A request with none of these headers is not a browser acting for a page (`curl`, a script) and is allowed. Cached Basic-auth credentials do not help a hostile page: its requests are refused by origin before the password matters.

The `Host` rule applies to a routable bind too: the address it bound is a name it answers to, and so is anything passed with `--allowed-host` (repeatable, or `TMUXY_ALLOWED_HOSTS`). A **wildcard** bind (`0.0.0.0`, `::`) answers on every address the machine has, so it accepts any IP literal — never a rebound name, since a page whose origin is an address was served by that address — and still refuses any hostname that is not loopback or allowed. Reaching a wildcard bind by name (a LAN hostname, a Codespaces forwarding domain) needs `--allowed-host`.

A container's published port is not a boundary on its own: Docker publishes `-p PORT:...` on every host interface, past the host firewall. `bin/devcontainer` publishes on `127.0.0.1` for that reason, since the dev server inside runs `--no-auth`.

## What the App Will Load and Draw

The web server sends every file of the app — the page, its bundle, its fonts, the user's stylesheets — with a `Content-Security-Policy`, `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff` (`tmuxy-server/src/server/lifecycle.rs`). Two directives carry most of the weight. `frame-src 'self'` keeps a preview's page in its frame: the embedder's `frame-src` is checked on every navigation of a frame, not only the first, so a page that sets its own `location` to another host is refused there — its own policy cannot stop that, since a document's `frame-src` governs only the frames inside it. Without this, an offline page could carry the files inlined into it to any host it named. `frame-ancestors 'none'` (and the older header) stops another site from framing the app under a decoy and steering the user's clicks onto a button such as a `pane send` question's "Allow"; a consequence is that no page, an editor's embedded browser included, can show the web UI in a frame. The rest of the policy says what the app loads: scripts, styles, fonts and connections from its own origin only, inline styles (React sets them), and images from anywhere, because a markdown preview opened with `--net` shows remote pictures. Under `--dev` the server sends only the framing directives, since Vite's page has an inline script and its HMR socket goes to the Vite port. The preview's own route, `/api/preview/{pane}`, is not one of the app's files and keeps the sandboxing policy described in [A Preview Reads One File](SECURITY-CONTENT.md#a-preview-reads-one-file).

The desktop webview carries its own `Content-Security-Policy` (`tauri.conf.json`). It is defence in depth rather than a boundary — an XSS from pane output would run with the Tauri IPC behind it, which is `open_url`, the app's schemes and CLI exec, so it is worth more here than on the web. The policy names each scheme the app actually loads from (`tauri:`, `asset:`, `tmuxyimg:`, `tmuxycss:`, and their `http://<scheme>.localhost` forms on Windows), and its `frame-src` names one: `tmuxypreview:`, the page a `preview` pane frames, which is served under its own sandboxing policy (see [A Preview Reads One File](SECURITY-CONTENT.md#a-preview-reads-one-file)). The app frames nothing else. **Adding a resource the app loads means adding it here too, and to the web policy above** — a CSP refuses quietly, and the symptom is a picture that simply does not appear.

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
