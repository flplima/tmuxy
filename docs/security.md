# Security

Tmuxy is a **development tool** that is **not production-ready**. It provides direct access to a user's tmux session, which means full shell access to the host machine. This document describes the security model, known risks, and mitigations.

## Development Status Warning

Tmuxy is under active development and has not undergone a security audit. It is designed for use on **trusted networks** (localhost, LAN, VPN) by a **single user**. Do not deploy it on untrusted networks without additional security layers.

## Threat Model

Tmuxy assumes:
- **Single user** per deployment (no multi-tenant access control)
- **Trusted network** (localhost, LAN behind firewall, or VPN)
- **Server runs as the same user** who owns the tmux session
- **All connected clients are equally trusted** (no per-client permissions)

If any of these assumptions are violated, the risks described below apply.

## Authentication

### Session Tokens

The web server generates a 128-bit random hex token (via `rand::thread_rng()`, cryptographically sound) for each SSE connection. The token is sent in the `connection-info` SSE event and must be included as the `X-Session-Token` header on all HTTP POST commands. Tokens are stored server-side in `AppState::sse_tokens` and destroyed on client disconnect.

### No User Authentication

There is **no user authentication**. Any client that can reach the server's network port can:
1. Open an SSE connection to `/events?session=<name>` (unauthenticated)
2. Receive a valid session token
3. Use that token to send arbitrary commands

The session token prevents cross-session interference (a token for session A cannot control session B) but does not authenticate users.

### Tauri Desktop App

The Tauri app has no network-level authentication concerns — all communication is local IPC within the app process. No tokens, no network exposure.

## Known Risks

### 1. Unauthenticated Remote Access (High)

**Risk:** Exposing the tmuxy server on a public IP without authentication gives anyone full control over the tmux session.

**Impact:** Arbitrary command execution on the host machine via `run-shell` commands or by typing into any pane.

**Mitigation:**
- **Never expose tmuxy directly to the internet**
- Use SSH tunnel: `ssh -L 9000:localhost:9000 user@server`
- Use VPN: WireGuard, Tailscale, or similar
- Use a reverse proxy with authentication (nginx + basic auth, Caddy + OAuth)
- Bind to localhost: `tmuxy server --host 127.0.0.1`

### 2. No TLS/HTTPS (High)

**Risk:** All communication is over plain HTTP. Session tokens, terminal content, and commands are transmitted in cleartext.

**Impact:** Network eavesdropping can capture session tokens (granting full session control), observe all terminal output, and see all keystrokes sent to tmux.

**Mitigation:**
- Use a reverse proxy (nginx, Caddy) with TLS certificates for HTTPS
- For LAN use, self-signed certificates are acceptable
- SSH tunnels provide encryption by default

### 3. Arbitrary Command Execution (High)

**Risk:** Authenticated clients can send any tmux command, including `run-shell` which executes arbitrary shell commands within the tmux server process.

**Impact:** Full shell access as the user running the tmux server. Can read/write files, start processes, modify system state.

**Context:** This is by design — tmuxy is a tmux UI, and tmux provides full shell access. However, if a session token leaks (via network interception, browser dev tools, or logs), anyone with the token has this access.

### 4. Unrestricted File Access (High)

**Risk:** The `/api/file` endpoint reads arbitrary files and `/api/directory` lists arbitrary directories, with no path restrictions beyond Unix file permissions.

**Impact:** Information disclosure — SSH keys, configuration files, source code, credentials, and any file readable by the server process.

**Mitigation:** The server should run as an unprivileged user. Do not run tmuxy as root.

### 5. Default Bind Address (Medium)

**Risk:** The server binds to `0.0.0.0` by default, making it accessible from any network interface.

**Impact:** On a machine connected to multiple networks (e.g., LAN + public WiFi), the server is reachable from all of them.

**Mitigation:** Use `--host 127.0.0.1` for localhost-only access. Use firewall rules to restrict port access.

### 6. Permissive CORS (Low)

**Risk:** CORS headers allow requests from any origin (`Access-Control-Allow-Origin: *`).

**Impact:** A malicious website could make requests to a locally-running tmuxy server if it can guess the port. Mitigated by the session token requirement — the attacker would need both network access and a valid token.

### 7. No Audit Logging (Medium)

**Risk:** No logging of commands executed, sessions created, or clients connected.

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

1. Run `tmuxy server --host 127.0.0.1` on the remote machine
2. From your local machine: `ssh -L 9000:localhost:9000 user@remote`
3. Open `http://localhost:9000` in your browser

SSH provides authentication, encryption, and access control. This is the recommended approach for single-user remote access.

### Remote Access via VPN (Recommended for Mobile)

```
Mobile/Laptop → VPN (WireGuard/Tailscale) → tmuxy server → tmux
```

1. Set up a VPN between your devices and the remote machine
2. Run `tmuxy server` on the remote machine (bind to VPN interface or `0.0.0.0` with firewall rules)
3. Access via the VPN IP address

This is the recommended approach for mobile access where SSH tunnels are impractical.

### Remote Access via Reverse Proxy (Alternative)

```
Browser → HTTPS → nginx/Caddy (+ auth) → HTTP → tmuxy server → tmux
```

1. Run `tmuxy server --host 127.0.0.1` on the server
2. Configure nginx or Caddy with:
   - TLS certificate (Let's Encrypt or self-signed)
   - Authentication (basic auth, OAuth, client certificates)
   - Proxy pass to `http://127.0.0.1:9000`
   - WebSocket/SSE support enabled

### What NOT to Do

- **Do NOT** expose tmuxy directly on a public IP without authentication
- **Do NOT** run tmuxy as root
- **Do NOT** use tmuxy on shared/multi-tenant servers without network isolation
- **Do NOT** rely on session tokens as the sole security layer — they are not a substitute for authentication
- **Do NOT** store secrets (API keys, passwords, SSH passphrases) in tmux sessions that are connected to tmuxy on a network

## Future Security Improvements

These are not currently implemented but would improve the security posture:

- **Optional authentication** — HTTP basic auth or bearer token for SSE connections
- **TLS support** — Built-in HTTPS with certificate configuration
- **Command allowlisting** — Restrict which tmux commands clients can execute
- **Read-only mode** — View terminal output without command execution
- **Audit logging** — Log all commands and client connections
- **Path restrictions** — Limit `/api/file` and `/api/directory` to specific directories
- **Rate limiting** — Prevent brute-force token guessing and command flooding
