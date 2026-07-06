# Tmuxy Architecture

Tmuxy is a web-based tmux interface. It provides a browser UI (or native desktop app) for managing tmux sessions with real-time state synchronization.

## Components

```
┌─────────────────────────────────────────────────────────┐
│  Clients                                                │
│  ┌───────────────────────┐  ┌────────────────────────┐  │
│  │ Browser (React+XState)│  │ Tauri Desktop App      │  │
│  └───────────┬───────────┘  └────────────┬───────────┘  │
└──────────────│───────────────────────────│──────────────┘
               │ SSE + HTTP POST           │ Tauri IPC
┌──────────────▼───────────────────────────▼──────────────┐
│  Backend                                                │
│  ┌───────────────────────┐  ┌────────────────────────┐  │
│  │ Web Server (Axum)     │  │ Tauri Shell            │  │
│  └───────────┬───────────┘  └────────────┬───────────┘  │
└──────────────│───────────────────────────│──────────────┘
               └─────────────┬─────────────┘
┌────────────────────────────▼────────────────────────────┐
│  tmuxy-core (Rust library)                              │
│  Runtime ↔ sans-IO state machine ↔ tmux -CC connection  │
└────────────────────────────┬────────────────────────────┘
                             │ control mode (tmux -CC)
┌────────────────────────────▼────────────────────────────┐
│  tmux server                                            │
└─────────────────────────────────────────────────────────┘
```

**tmuxy-core** — Rust library that manages tmux control mode connections. Owns the sans-IO state aggregator, the `TmuxMonitor` runtime that drives it against a live `tmux -CC` subprocess, a substitutable execution context (`Ctx`) for I/O capabilities, and a Tower middleware stack for async tmux dispatch (timeout + retry + tracing in one place). Synchronous subprocess helpers in `executor` are kept for CLI/blocking paths. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) for details.

**tmuxy-server** — Axum HTTP server providing SSE streaming (with `Last-Event-Id` resync), HTTP POST command endpoints, and embedded frontend assets. Manages per-session connections, multi-client viewport sizing, and structured shutdown. Supports both production mode (embedded assets) and dev mode (`--dev` flag, proxies to Vite).

**tmuxy-ui** — React frontend using XState for all state management. Communicates with the backend via an adapter pattern (`TmuxAdapter` interface). Includes an in-browser demo engine (`DemoAdapter`, `DemoTmux`, and `LifoShell` — a real in-browser shell backed by `@lifo-sh/core`) for the demo site. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) for the XState architecture.

**tmuxy-tauri-app** — Optional desktop wrapper using Tauri. Communicates via native IPC instead of HTTP, offering lower latency. Currently single-client only (no multi-client support). See [DATA-FLOW.md](DATA-FLOW.md) for the Tauri data flow.

## How They Interact

1. The **frontend** connects to the backend via SSE (web) or Tauri events (desktop) to receive real-time state updates, and sends commands via HTTP POST (web) or Tauri invoke (desktop).

2. The **backend** maintains one `TmuxMonitor` per tmux session. When the first client connects to a session, a monitor is spawned. When the last client disconnects, the monitor shuts down.

3. The **monitor** holds a `ControlModeConnection` — a persistent `tmux -CC attach-session` subprocess. All state-modifying commands go through the control mode stdin connection. See [TMUX.md](TMUX.md) for why this is critical.

4. tmux sends real-time notifications (`%output`, `%layout-change`, `%window-add`, etc.) through control mode stdout. The `StateAggregator` processes these into `StateUpdate` objects (full snapshots or incremental deltas).

5. State updates are emitted via the `StateEmitter` trait — `SseEmitter` broadcasts to all SSE clients in a session, `TauriEmitter` emits Tauri events to the desktop app.

6. The frontend's XState machine merges state updates into its context, and React components re-render via selector hooks. See [DATA-FLOW.md](DATA-FLOW.md) for detailed flow diagrams.

## Multi-Client Viewport Sizing

Like native tmux, when multiple browser clients connect to the same session, the session is sized to the **smallest client's viewport**. Each client reports its viewport size, the server computes the minimum, and sends a resize command through the monitor's control mode connection. Resize commands must go through control mode — external `tmux resize-window` commands are ignored when a control mode client is attached.

## Key Design Decisions

1. **One monitor per session** — Avoids duplicate control mode connections and ensures resize commands work reliably.

2. **All commands through control mode** — External tmux subprocess calls can crash the tmux server when control mode is attached. See [TMUX.md](TMUX.md).

3. **State machine + client model in frontend** — XState owns UI-mode finite states (connecting / idle / removingPane, drag, resize, copy mode, command mode). The tmux world itself lives in a dedicated `TmuxClientModel` (`src/tmux/store/`) with explicit committed / pending-ops / derived layers, owned by an Effect-managed Ref. The appMachine bridges them by routing `SEND_TMUX_COMMAND` and `TMUX_STATE_UPDATE` through `tmuxStoreActor`. React components remain purely presentational — no `useEffect` side effects.

4. **Adapter pattern for transport** — `TmuxAdapter` interface abstracts SSE/HTTP vs Tauri IPC, making the frontend transport-agnostic.

5. **Delta protocol** — After the initial full state snapshot, the server sends incremental deltas (changed panes, windows) to minimize bandwidth.

6. **Adaptive throttling** — The monitor throttles state emissions during high-frequency output (~60fps cap), and emits immediately during low-frequency interactions for responsive typing feedback. Tunables live on `MonitorConfig`.

7. **Sans-IO core, runtime at the edges** — The state aggregator is pure: events in, typed `SideEffect`s out, no I/O of its own. The runtime executes those effects against a substitutable `Ctx` (clock / tmux / filesystem trait objects). Tests can drive the aggregator without spinning a real tmux.

8. **Policy as data** — Retry and timeout for async tmux dispatch are values, not hard-coded constants. They flow through a Tower middleware stack (`TraceLayer → RetryLayer → TimeoutLayer → TmuxService`) with one composition point in code.

## Crate layout

Each crate's source tree is one `ls packages/<crate>/src` away — the durable thing to know is **what each crate owns**, not which files happen to currently exist.

| Crate | Owns |
|-------|------|
| `tmuxy-core` | `tmux -CC` subprocess management, control-mode event parsing, the sans-IO state aggregator, `TmuxMonitor` runtime, substitutable `Ctx` (clock/tmux/fs), retry policy, Tower middleware stack, typed `TmuxError`. |
| `tmuxy-server` | Axum HTTP server, SSE streaming with `Last-Event-Id` resync, typed `ClientCommand` enum for the HTTP POST endpoint, per-session client tracking, structured shutdown, embedded frontend assets (prod) or Vite proxy (dev). |
| `tmuxy-ui` | React frontend, XState machine, optimistic `TmuxClientModel`, Effect-based adapter facade with typed errors, in-browser demo engine, and the v86 client-side adapter (real tmux in an in-browser x86 emulator). |
| `tmuxy-wasm` | wasm-bindgen facade over tmuxy-core's sans-IO control-mode parser + state aggregator, so browsers can reconstruct tmux state with the exact code the native server runs. Build via the root `build:wasm` script. |
| `tmuxy-tauri-app` | Tauri desktop wrapper. Uses the same `TmuxMonitor` + `Ctx` plumbing as the server; transport is native IPC instead of SSE/HTTP. |

## Related Documentation

| Document | Covers |
|----------|--------|
| [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) | Frontend XState + backend Rust state in detail |
| [DATA-FLOW.md](DATA-FLOW.md) | SSE/HTTP protocol, Tauri IPC, real-world deployment scenarios |
| [TMUX.md](TMUX.md) | Control mode routing, version-specific bugs, workarounds |
| [COPY-MODE.md](COPY-MODE.md) | Client-side copy mode reimplementation |
| [SECURITY.md](SECURITY.md) | Security risks, mitigations, deployment warnings |
| [TESTS.md](TESTS.md) | Testing guidelines and principles |
| [NON-GOALS.md](NON-GOALS.md) | What tmuxy intentionally does NOT do |
| [RICH-RENDERING.md](RICH-RENDERING.md) | Terminal image/OSC protocol support |
