# Data Flow

This document describes how data moves through tmuxy in different deployment scenarios, covering the SSE/HTTP protocol, Tauri IPC, and real-world use cases.

## Transport: SSE/HTTP (Web Version)

The web version uses two HTTP endpoints on the Axum server:

**`GET /events?session=<name>`** — Server-Sent Events stream (server-to-client):
- `connection-info` — Connection ID and default shell (sent on connect)
- `keybindings` — Prefix key and all key bindings from tmux config
- `state-update` — Full state snapshots and incremental deltas (serialized JSON)
- `clipboard` — OSC 52 clipboard payloads forwarded from terminal applications
- `log`, `error`, `fatal` — Diagnostic and error notifications

**`POST /commands?session=<name>`** — HTTP POST (client-to-server):
- Request body: `{ "cmd": "command_name", "args": {...} }`
- Response: `{ "result": ... }` or `{ "error": "message" }`
- **No authentication by default** (optional `--password` HTTP Basic gate) — see [SECURITY.md](SECURITY.md). Without a password, network reachability is the only gate.

SSE was chosen over WebSocket because: server-to-client is the dominant direction, `EventSource` has built-in browser reconnection, SSE works through all proxies/CDNs, and the standard `Last-Event-Id` mechanism gives us a clean reconnect path (see below).

### SSE resync via `Last-Event-Id`

Every event the server broadcasts is tagged with a monotonic per-session sequence id (set as the SSE `id:` field). `EventSource` persists the last received id across reconnects and sends it back as the `Last-Event-Id` request header on retry. The server keeps a small ring buffer of recent events per session and replays everything strictly newer than the supplied id before resuming the live stream. If the client's id is older than the buffer head (long disconnect), the next full-state snapshot covers the gap — no client-side panic, no data corruption.

This is independent from the delta protocol's own `seq` field: the SSE id keeps the *transport* in sync after a reconnect; the delta `seq` keeps the *application state* in sync after each individual update.

## Transport: Tauri IPC (Desktop Version)

The Tauri desktop app bypasses the network stack entirely:

**`invoke(cmd, args)`** — Client-to-server commands (equivalent to HTTP POST). Calls Rust functions directly through Tauri's IPC bridge. The `TauriAdapter` dynamically imports `@tauri-apps/api/core` to call `invoke()`.

**Tauri events** — Server-to-client state updates (equivalent to SSE). The `TauriEmitter` calls `app.emit("tmux-state-update", &update)` to push state changes. The frontend listens via `listen<StateUpdate>('tmux-state-update', handler)`.

Tauri IPC has lower latency than HTTP since communication is in-process. The Tauri app is currently single-client only (no multi-client viewport sizing).

## Adapter Pattern

Both transports implement the `TmuxAdapter` interface defined in `tmuxy-ui/src/tmux/types.ts`. Key methods: `connect()`, `disconnect()`, `isConnected()`, `isReconnecting()`, `invoke<T>(cmd, args?)`, `onStateChange(listener)`, `onError(listener)`, `onConnectionInfo(listener)`, `onReconnection(listener)`, `onKeyBindings(listener)`, `onLog(listener)`, `onFatal(listener)`. Optional members: `onClipboard(listener)` (OSC 52 clipboard writes), `switchSession(sessionName)`, `enumeratesSessions` (gates the sidebar sessions poll), and `queryReadonly(command)` (read-only queries that bypass the mutation queue).

The `tmuxActor` XState actor uses whichever adapter is injected, making the frontend transport-agnostic. Two more adapters exist beyond the SSE and Tauri transports: `DemoAdapter` (in-browser demo — simulates a tmux backend) and `V86TmuxAdapter` (fully client-side **real** tmux — see Scenario 4 below).

## Connection Lifecycle (Web)

1. Client opens SSE connection: `GET /events?session=<name>`
2. Server assigns a unique `connection_id`
3. Server checks if a `TmuxMonitor` exists for the session:
   - **No monitor:** Spawns a new monitor (connects `tmux -CC`), stores handle in `SessionConnections`
   - **Has monitor:** Subscribes to the existing broadcast channel and replays from the ring buffer if the client supplied a `Last-Event-Id`
4. Client receives `connection-info` event with connection ID and default shell
5. Client sends `get_initial_state` (via HTTP POST) with its viewport size (cols, rows)
6. Server stores the client size, computes the minimum viewport across all clients, and sends a resize command through the monitor's control mode connection
7. Client receives full state snapshot, then incremental deltas as tmux state changes
8. On disconnect: server removes the client, recomputes minimum viewport, and shuts down the monitor if no clients remain

## Connection Lifecycle (Tauri)

1. App starts, reads `TMUXY_SESSION` env var (defaults to "tmuxy")
2. `monitor::start_monitoring()` spawns a background task that connects to tmux control mode
3. On connection failure: exponential backoff (100ms to 10s max); after 5 consecutive failures the monitor **parks** — the loop stays alive but stops retrying until a user-requested reconnect (`tmuxy connect` or the sidebar server picker) revives it (see `packages/tmuxy-tauri-app/src/monitor.rs`)
4. Once connected: emits keybindings, then enters the monitor event loop
5. Frontend's `TauriAdapter.connect()` sets up event listeners for `tmux-state-update`, `tmux-keybindings`, and `tmux-error`
6. No explicit disconnect — the monitor runs for the app's lifetime

## State Update Flow

```
tmux server
    │ control mode stdout (%output, %layout-change, etc.)
    ▼
TmuxMonitor                              ← runtime (drives the aggregator,
    │                                      executes the SideEffects it returns)
    │  aggregator.step(event) → SideEffect[]
    ▼
StateAggregator (sans-IO state machine)
    │  no I/O of its own — only describes what should happen
    ▼
SideEffect dispatch (refresh-panes, emit-state, store-image, ...)
    │
    │  emit_state path:
    ▼                     ┌─────────────────────┐
                          │   StateEmitter trait │
                          └──────────┬──────────┘
              ┌──────────────────────┴──────────────────────┐
              ▼                                             ▼
         SseEmitter                                  TauriEmitter
   (per-session ring buffer + broadcast)            (app.emit())
              │                                             │
        ┌─────┼─────┐                                       │
        ▼     ▼     ▼                                       ▼
    Client1 Client2 Client3                          Tauri frontend
```

The monitor multiplexes control-mode events with timer-driven flushes (throttle, settling, layout debounce, periodic sync) and external commands (resize, run-command, shutdown). The exact set of `tokio::select!` arms drifts as we tune timings; the durable contract is:
- The aggregator decides **what** state effects exist.
- The monitor decides **when** to flush them (throttle / debounce / settle).
- The emitter decides **where** they go (SSE broadcast vs Tauri event).

## Command Execution Flow

Frontend `adapter.invoke(cmd, args)` is decoded into a typed `ClientCommand` variant on the server (or routed straight through Tauri IPC). Mutating commands route through the monitor's control-mode connection — never through external subprocesses, because external `tmux` calls crash tmux 3.5a when a control-mode client is attached (see [TMUX.md](TMUX.md)).

Read-only async tmux dispatch (e.g., scrollback fetch, theme get/set) flows through the Tower stack (`AppState::tmux_call`) so it picks up the standard timeout, retry, and tracing in one place. Sync helpers in `executor::*` remain for CLI/blocking contexts.

**Gotcha — `run_tmux_command` return value differs by transport.** On the **web** server the generic `run_tmux_command` hands the command to the control-mode channel fire-and-forget and resolves to `null` — there is no stdout to return, because the result of a control-mode command arrives later as a state event, not as the POST response. On **Tauri** the same call falls through to an `executor::run_tmux_command_for_session` subprocess and **does** return the command's stdout. So a web caller that needs a command's output cannot use the plain path. The exception carved out for the sidebar sessions poll: the web `RunTmuxCommand` handler runs a small allowlist of read-only enumeration commands (`list-windows`/`list-panes`/`list-sessions`, gated by `is_readonly_query` in `sse.rs`) as one-off subprocesses and returns their stdout, matching Tauri — safe because these are read-only (see [TMUX.md](TMUX.md#commands-safe-to-run-as-external-subprocesses)). Prefer a dedicated typed command over widening that allowlist.

```
Frontend
    │ adapter.invoke(cmd, args)
    ▼
┌──────────────────────────────────────────┐
│  Backend                                 │
│  ┌──────────────┐    ┌────────────────┐  │
│  │ Web: POST    │    │ Tauri:         │  │
│  │ /commands    │    │ invoke()       │  │
│  └──────┬───────┘    └─────────┬──────┘  │
│         ▼                      ▼         │
│   ClientCommand variant   Tauri command  │
│         │                      │         │
│   ┌─────┴──────┐               │         │
│   ▼            ▼               ▼         │
│  Tower      Monitor       Monitor or     │
│  stack      command       executor       │
│ (async      channel       (per use case) │
│  tmux)      (mutations)                  │
└─────────┬────────────────────────┬───────┘
          └────────────┬───────────┘
                       ▼
              Monitor stdin → tmux
```

## Delta Protocol

After the initial full state snapshot, the server sends incremental deltas to minimize bandwidth:

- Each delta has a `seq` number for ordering
- Deltas contain only changed fields: modified panes (content, cursor, metadata), added/removed panes, added/removed windows, active pane/window changes, status line changes
- The frontend merges deltas into its cached state via `handleStateUpdate()` in `tmuxy-ui/src/tmux/deltaProtocol.ts`
- If a delta arrives with a sequence gap, the client requests a full state resync

## Keyboard Input Flow

1. User presses a key in the browser
2. `keyboardActor` captures the DOM `keydown` event
3. If in copy mode: key routed to `COPY_MODE_KEY` handler (handled client-side, see [COPY-MODE.md](COPY-MODE.md))
4. If prefix key pressed: enters prefix mode, waits for next key to match a binding
5. Otherwise: `keyboardActor` sends `SEND_TMUX_COMMAND` with `send -t <session> <key>`
6. The `KeyBatcher` in the adapter batches rapid keystrokes (e.g., typing "hello") into single `send-keys` commands
7. Command reaches tmux via control mode stdin
8. tmux processes the keystroke and sends `%output` event back through control mode stdout
9. Monitor emits a state delta with the updated pane content
10. Frontend re-renders the affected pane

---

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
- Single client (Tauri doesn't support multi-client)
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
- Saved servers live in `~/.config/tmuxy/servers.json` (`packages/tmuxy-core/src/servers.rs`); each entry's optional `ssh` field maps to the same `TMUXY_SSH` value. The desktop sidebar's server picker and the `tmuxy connect` form select an entry and reconnect the monitor live.
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
1. User runs `tmuxy server` on the VM (binds to `0.0.0.0:9000` by default)
2. User opens `https://vm-ip:9000` in their browser (requires a reverse proxy for HTTPS — see below)
3. Browser opens SSE connection to `/events?session=<name>`
4. All subsequent commands use HTTP POST to `/commands?session=<name>`
5. State updates stream via SSE in real-time

**Security considerations (critical):**

The tmuxy server has **no authentication by default** (an optional `--password` / `TMUXY_PASSWORD` HTTP Basic gate exists — see SECURITY.md) and **no TLS**. Exposing it directly on a public IP means:
- Without a password, anyone who discovers the IP and port can connect to and control your tmux session
- All traffic is in cleartext (eavesdropping reveals terminal content and lets attackers inject commands; Basic-auth credentials are only base64, not encrypted)
- `run-shell` commands allow arbitrary code execution on the server
- File reading endpoints have no path restrictions

**Required mitigations for this scenario:**
1. **Never expose tmuxy directly to the internet.** Use one of:
   - SSH tunnel: `ssh -L 9000:localhost:9000 user@vm` (recommended for single user)
   - VPN: WireGuard, Tailscale, or similar (recommended for mobile access)
   - Reverse proxy with authentication: nginx/Caddy + basic auth or OAuth + TLS
2. **Bind to localhost:** Use `tmuxy server --host 127.0.0.1` if accessed only via SSH tunnel
3. **Set a password:** `tmuxy server --password …` gates all routes with HTTP Basic auth — a barrier against opportunistic scans, but pair it with TLS since credentials cross the wire in cleartext
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
- No authentication by default — optional `--password` Basic auth, otherwise rely on external layers (SSH, VPN, reverse proxy)
- Latency affects typing feel — no local echo or input prediction (see [NON-GOALS.md](NON-GOALS.md))

### Scenario 4: Fully Client-Side — Real tmux in the Browser (v86 + WASM)

No server at all. Real tmux 3.7a runs inside a v86 x86 emulator (a small buildroot Linux restored from a pre-booted state snapshot), and its `tmux -CC` control-mode stream is parsed by **tmuxy-core compiled to WebAssembly** — the same Rust parser and state aggregator the native server runs.

```
TmuxyApp ──invoke(run_tmux_command)──> V86TmuxAdapter ──> V86Engine
   ▲                                                          │ byte-paced writes
   │                                                          ▼
onStateChange <── tmuxy-wasm (parse + aggregate) <──serial── tmux -CC in v86 guest
```

Key pieces (all under `tmuxy-ui/src/tmux/v86/`):

| Piece | Responsibility |
|-------|----------------|
| `V86Engine` | Owns the emulator: byte-paced UART writer (whole-command writes overrun the guest 16550 FIFO and corrupt commands), serial coalescing, tick/sync timers, `%exit`→fatal detection, and a guest bootstrap re-applied on every attach (snapshot restores rewind the filesystem). |
| `V86TmuxAdapter` | The `TmuxAdapter` facade: translates frontend commands for raw control-mode stdin (separator + format-expansion rewrites per TMUX.md), serves themes/keybindings/images locally. |
| shared engine | Opt-in: many adapters reuse one booted machine; each consumer restores the pinned snapshot with a fresh WASM core (~1s) instead of cold-booting (~5s). |

Used by the Storybook `Scenarios/Application` stories and intended for the public demo. Assets (kernel, BIOS, state snapshot, wasm bindings) are served statically; nothing leaves the browser.

This scenario is CI-tested: the `storybook-v86-probe` job builds the wasm bindings and guest assets (cached on the build-script hash), starts a Storybook dev server, and drives every `v86`-tagged story on one shared page (`tmuxy-ui/scripts/probe-spikes.mjs`). The deterministic stories run in the parallel `storybook-probe` job. See `docs/TESTS.md` § Storybook Tests.

## Additional API Endpoints

Beyond the core SSE/HTTP protocol, the web server exposes:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/events` | GET | SSE stream (state updates, connection info) |
| `/commands` | POST | tmux commands (no authentication unless `--password` is set — see SECURITY.md) |
| `/api/file` | GET | Read file contents (used by widget panes) |
| `/api/images/{pane_id}/{image_id}` | GET | Serve a decoded inline-image blob |

The `/api/file` endpoint exists for widget rendering (markdown viewer, image viewer). Like every route it is gated by the optional `--password` Basic auth, but has no path restrictions beyond that. See [SECURITY.md](SECURITY.md) for the implications.
