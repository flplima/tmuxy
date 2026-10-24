# Data Flow: Desktop IPC, Deployments and Endpoints

The Tauri transport, real-world deployment scenarios and the extra HTTP endpoints. Part of [DATA-FLOW.md](DATA-FLOW.md).

## Transport: Tauri IPC (Desktop Version)

The Tauri desktop app bypasses the network stack entirely:

**`invoke(cmd, args)`** — Client-to-server commands (equivalent to HTTP POST). Calls Rust functions directly through Tauri's IPC bridge. The `TauriAdapter` dynamically imports `@tauri-apps/api/core` to call `invoke()`.

**Tauri events** — Server-to-client state updates (equivalent to SSE). The `TauriEmitter` pushes state changes with `emit_to(<window label>, "tmux-state-update", …)`, addressed to one window rather than broadcast. The frontend listens via `listen<StateUpdate>('tmux-state-update', handler)`.

Tauri IPC has lower latency than HTTP since communication is in-process.

**One monitor per GUI window.** The desktop app can have several OS windows open on one tmux session (Window ▸ New Window). Each is its own client: its own webview, its own control-mode monitor, and its own tmux session, with the sessions members of one tmux _session group_ — they share every window and pane while each keeps its own current window, which is what puts two tabs of one session on screen at once. The first window holds the group's base session (the one `TMUXY_SESSION` names) and every later one attaches to `<base>~<index>` (`tmux -CC new-session -A -s <base>~2 -t <base>`); a window's session is killed when its window closes, which leaves the shared windows alive in the remaining members. A registry keyed by webview label (`tmuxy-tauri-app/src/windows.rs`) is what turns a command back into the monitor that must run it, so a mutation from window 2 moves window 2's current tab and not the other's. Per-session events (state, errors, logs, clipboard, detach) are addressed to the one window; server-wide ones (keybindings, theme settings) are still broadcast.

## Connection Lifecycle (Tauri)

1. App starts, reads `TMUXY_SESSION` env var (defaults to "tmuxy")
2. `monitor::start_monitoring()` spawns a background task that connects to tmux control mode
3. On connection failure: exponential backoff (100ms to 10s max); after 5 consecutive failures the monitor **parks** — the loop stays alive but stops retrying until a user-requested reconnect (`tmuxy connect` or the sidebar server picker) revives it. The loop is `transport::supervise` in tmuxy-core, shared with the web server; parking, the server switch and the detach are the desktop's `Host` (`packages/tmuxy-tauri-app/src/monitor.rs`), where the web server's stops instead
4. Once connected: emits keybindings, then enters the monitor event loop
5. Frontend's `TauriAdapter.connect()` sets up event listeners for `tmux-state-update`, `tmux-keybindings`, `tmux-theme-settings`, `tmux-css-changed`, and `tmux-error`
6. No explicit disconnect — the monitor runs for the app's lifetime

## Real-World Deployment Scenarios

### Scenario 1: Developer Using Tauri Desktop App with Local tmux

**Setup:** Developer runs the Tauri desktop app on their workstation. tmux server runs locally.

```
┌─────────────────────────────────────────────────┐
│  Developer's Machine                            │
│                                                 │
│  ┌─────────────┐    ┌────────────────────────┐  │
│  │ Tauri App   │    │ tmuxy-core (Rust)      │  │
│  │ (React UI)  │◄──►│ TmuxMonitor            │  │
│  │             │IPC │ ControlModeConnection   │  │
│  └─────────────┘    └───────────┬────────────┘  │
│                                 │ stdin/stdout   │
│                       ┌─────────▼──────────┐    │
│                       │ tmux server        │    │
│                       │ (local daemon)     │    │
│                       └────────────────────┘    │
└─────────────────────────────────────────────────┘
```

**Data flow:**

1. Tauri app starts, reads `TMUXY_SESSION=dev` from environment
2. `TmuxMonitor` attaches to local tmux session via `tmux -CC attach-session -t dev`
3. All IPC is in-process — no network involved
4. Latency: sub-millisecond for commands, near-instant state updates

**Characteristics:**

- Lowest possible latency (no network stack)
- No security concerns (local IPC only)
- One control-mode monitor per GUI window, each on its own session in a shared session group (see **One monitor per GUI window** above)
- Native desktop integration (system menus, keyboard shortcuts)

### Scenario 2: Developer Using Tauri Desktop App with Remote tmux via SSH

**Setup:** Developer runs the Tauri app locally but attaches to a tmux session on a remote server via SSH.

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  Developer's Machine     │         │  Remote Server           │
│                          │         │                          │
│  ┌──────────┐            │   SSH   │   ┌────────────────────┐ │
│  │ Tauri App│◄──────────►│◄───────►│   │ tmux server       │ │
│  │ (React)  │  IPC       │  tunnel │   │ (remote daemon)   │ │
│  └──────────┘            │         │   └────────────────────┘ │
└──────────────────────────┘         └──────────────────────────┘
```

**How it works:**

- There is no SSH library — tmuxy shells out to the system `ssh` client. The `TMUXY_SSH` env var holds a whitespace-separated ssh argv tail (options plus destination, e.g. `-p 2222 user@host`). When set, every tmux invocation is wrapped as `ssh … tmux …` by `tmux_argv`/`ssh_target` in `packages/tmuxy-core/src/session.rs` — with `-tt` (remote tty allocation) for the `-CC` control-mode attach, and without it for one-off reads.
- Saved servers live in `~/.config/tmuxy/servers.json` (`packages/tmuxy-core/src/servers.rs`); each entry's optional `ssh` field maps to the same `TMUXY_SSH` value. The desktop sidebar's server picker selects an entry and `tmuxy session connect` adds one; both reconnect the monitor live.
- The `TmuxMonitor` and `ControlModeConnection` are transport-agnostic — they read/write stdin/stdout of a child process, so the ssh hop is invisible to them.
- The Tauri monitor's reconnect loop (backoff, park after repeated failures, revive on user reconnect — see Connection Lifecycle above) applies to SSH targets the same as local ones.
- Latency is handled by the monitor's adaptive throttling; there is no local echo or input prediction (see [NON-GOALS.md](NON-GOALS.md)).

### Scenario 3: Remote Server with Web Access

**Setup:** User runs `tmuxy server` on a remote cloud VM and accesses it from a browser on their laptop or mobile phone.

```
┌───────────────────┐         ┌──────────────────────────────────────┐
│  User's Device    │         │  Cloud VM                            │
│  (laptop/mobile)  │         │                                      │
│                   │         │  ┌──────────────┐  ┌──────────────┐  │
│  ┌────────────┐   │  HTTPS  │  │ tmuxy-server │  │ tmux server  │  │
│  │  Browser   │◄──┼────────►│  │ (Axum)       │◄►│ (daemon)     │  │
│  │  (React)   │   │   SSE   │  │ port 9000    │  │              │  │
│  └────────────┘   │  + POST │  └──────────────┘  └──────────────┘  │
│                   │         │                                      │
└───────────────────┘         └──────────────────────────────────────┘
```

**Data flow:**

1. User runs `TMUXY_PASSWORD=… tmuxy server --host 0.0.0.0` on the VM (plain `tmuxy server` listens on `127.0.0.1:9000` only, and a routable address needs a password or an explicit `--no-auth`)
2. User opens `https://vm-ip:9000` in their browser (requires a reverse proxy for HTTPS — see below)
3. Browser opens SSE connection to `/events?session=<name>`
4. All subsequent commands use HTTP POST to `/commands?session=<name>`
5. State updates stream via SSE in real-time

**Security considerations (critical):**

The tmuxy server has **no TLS**, and on a routable address its only gate is an HTTP Basic password (`--password` / `TMUXY_PASSWORD`) — or none, with `--no-auth`. See SECURITY.md. Exposing it directly on a public IP means:

- Anyone who discovers the IP and port can try the password, with no rate limit — and with `--no-auth` simply controls your tmux session
- All traffic is in cleartext (eavesdropping reveals terminal content and lets attackers inject commands; Basic-auth credentials are only base64, not encrypted)
- `run-shell` commands allow arbitrary code execution on the server
- File reading endpoints have no path restrictions

**Required mitigations for this scenario:**

1. **Never expose tmuxy directly to the internet.** Use one of:
   - SSH tunnel: `ssh -L 9000:localhost:9000 user@vm` (recommended for single user)
   - VPN: WireGuard, Tailscale, or similar (recommended for mobile access)
   - Reverse proxy with authentication: nginx/Caddy + basic auth or OAuth + TLS (start the server with `--allowed-host <public name>`)
2. **Keep the default address for a tunnel:** plain `tmuxy server` listens on 127.0.0.1, which is all an SSH tunnel needs
3. **Set a password on any other address:** `TMUXY_PASSWORD=… tmuxy server --host …` gates all routes with HTTP Basic auth — a barrier against opportunistic scans, but pair it with TLS since credentials cross the wire in cleartext
4. **Use a reverse proxy for TLS:** The server does not support HTTPS natively

See [SECURITY.md](SECURITY.md) for the full threat model and recommendations.

**What works today:**

- SSE streaming with delta protocol works well over high-latency connections
- `EventSource` auto-reconnects on brief network drops
- Multi-client support — multiple browser tabs/devices can connect simultaneously
- Viewport auto-sizing to the smallest connected client
- Mobile browsers work (touch events are translated to mouse events)

**Limitations:**

- No offline capability — requires constant network connection
- No compression — JSON payloads can be large during rapid output (mitigated by delta protocol)
- Only HTTP Basic auth (`--password`) built in; for anything stronger rely on external layers (SSH, VPN, reverse proxy)
- Latency affects typing feel — no local echo or input prediction (see [NON-GOALS.md](NON-GOALS.md))

### Scenario 4: Fully Client-Side — Real tmux in the Browser (v86 or CheerpX + WASM)

No server at all. Real tmux runs inside an in-browser guest machine, and its `tmux -CC` control-mode stream is parsed by **tmuxy-core compiled to WebAssembly** — the same Rust parser and state aggregator the native server runs. Two guests share everything but the machine:

- **v86** — an x86 emulator running a small buildroot Linux restored from a pre-booted state snapshot; the control client is on its UART.
- **CheerpX** — an x86-to-WebAssembly JIT running 32-bit Alpine binaries from an ext2 image streamed over HTTP; the control client is on its console, through the guest's `tmuxy-console` relay. Faster and with no kernel to boot, but it needs a cross-origin isolated page (COOP + COEP headers), and its kernel lacks enough that the guest's tmux is patched and every pane runs under `tmuxy-pty` (see `packages/tmuxy-ui/cheerpx/README.md`).

```
TmuxyApp ──invoke(run_tmux_command)──> GuestTmuxAdapter ──> GuestEngine (V86Engine | CheerpXEngine)
   ▲                                                              │ send
   │                                                              ▼
onStateChange <── tmuxy-wasm (parse + aggregate) <──stream── tmux -CC in the guest
```

Key pieces (under `tmuxy-ui/src/infra/transport/drivers/`):

| Piece | Responsibility |
| --- | --- |
| `guest/GuestEngine` | The machine-independent control-mode client: the wasm core, tick/sync timers, `%exit`→fatal detection, the attach-and-sync loop with a per-attach guest setup, and a serialized boot/reset lifecycle. Marker-bracketed commands (tracked mutations, scrollback captures, in `guest/controlMode.ts`) send their markers as separate lines, as the native monitor does — invariant A6 in INVARIANTS.md. |
| `guest/GuestTmuxAdapter` | The driver behind `GuestTransportLive`: translates frontend commands for raw control-mode stdin (separator + format-expansion rewrites per TMUX.md), serves themes/keybindings/images locally. The first frame is the finished start: the session is sized to the client's viewport before the first state is answered, as the server does, and an init whose work outlives its commands (a shell line it typed) names a tmux option it sets when done (`initDoneOption`), which `connect()` waits for. Files the page hands it (`files`: text, or a URL it fetches) are in the guest's `/mnt` before the init runs: v86's 9p share, a CheerpX in-memory device mounted at the same path. |
| `v86/V86Engine` | The v86 machine: a UART writer paced under the rate the guest drains its input (v86's UART queue is unbounded; the guest reads ~45 KB/s, and a slower pace turns the queue into the bottleneck behind every keystroke) and serial coalescing. Snapshot restores rewind the filesystem, so the guest setup is re-applied on every attach. |
| `v86` shared engine | Opt-in: many adapters reuse one booted machine; each consumer restores the pinned snapshot with a fresh WASM core (~1s) instead of cold-booting (~5s). |
| `cheerpx/CheerpXEngine` | The CheerpX machine: CheerpX from its CDN, the image with a fresh IndexedDB overlay per page load, the relay on the console. |

The public demo site (`packages/tmuxy-demo`) runs CheerpX where the page is cross-origin isolated (its dev server sends the headers) and v86 elsewhere; `?guest=v86` asks for v86. The Storybook `v86` stories run v86. Assets (kernel, BIOS, state snapshot, ext2 image, wasm bindings) are served statically; nothing leaves the browser.

The v86 guest is CI-tested: the `storybook-v86-probe` job builds the wasm bindings and guest assets (cached on the build-script hash), starts a Storybook dev server, and drives the gate stories on one shared page (`tmuxy-ui/scripts/probe-spikes.mjs`); every `v86`-tagged story runs nightly in `nightly-v86.yml`. The deterministic stories run in the parallel `storybook-probe` job. See `docs/TESTS.md` § Storybook Tests. The CheerpX guest has no automated test yet.

## Additional API Endpoints

Beyond the core SSE/HTTP protocol, the web server exposes:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/events` | GET | SSE stream (state updates, connection info) |
| `/commands` | POST | tmux commands (no authentication unless `--password` is set — see SECURITY.md) |
| `/api/images/{pane_id}/{image_id}` | GET | Serve a decoded inline-image blob |
| `/themes/{name}.css`, `/custom.css` | GET | The user's stylesheets from the config dir (a built-in theme name falls back to the bundled copy) |

The stylesheet routes are answered by `tmuxy_core::session::resolve_user_css` in both builds: the web server serves them at the app's origin (ahead of the embedded bundle, and ahead of the Vite proxy in dev mode), the desktop app over its `tmuxycss:` scheme, and `tmuxy-ui/src/utils/themeManager.ts` picks between the two. Both hosts poll the config dir once a second (`transport::watch_config`): a saved stylesheet becomes a `css-changed` push, a saved `tmuxy.conf` is sourced on the control-mode connection and followed by the `keybindings` and `theme-settings` pushes a client's own `source-file` gets. `tmuxy config reload` is that second path — it marks the file modified and nothing more. See [ARCHITECTURE.md](ARCHITECTURE.md) for what the config dir holds.

Every route is gated by the optional `--password` Basic auth. See [SECURITY.md](SECURITY.md).
