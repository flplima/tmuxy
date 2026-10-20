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

**tmuxy-core** — Rust library that manages tmux control mode connections. Owns the sans-IO state aggregator, the `TmuxMonitor` runtime that drives it against a live `tmux -CC` subprocess, and the tmux reads both transports share (`transport.rs`: scrollback, key bindings, theme, snapshots), all of which go over the control-mode connection. `executor` holds the command-string helpers (quoting, the `new-window` rewrite, `list-keys` parsing); the only subprocesses left are the session preflight and creation in `session.rs`, before any client is attached. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) for details.

**tmuxy-server** — Axum HTTP server providing SSE streaming (with `Last-Event-Id` resync), HTTP POST command endpoints, and embedded frontend assets. Manages per-session connections, multi-client viewport sizing, and structured shutdown. Supports both production mode (embedded assets) and dev mode (`--dev` flag, proxies to Vite).

**tmuxy-ui** — React frontend using XState for all state management. Reaches the backend through the `TmuxTransport` Effect service (one Layer per transport). Includes two in-browser engines: the v86 one (`V86TmuxAdapter` — real tmux and bash in an x86 emulator, its control-mode stream parsed by tmuxy-core compiled to wasm), which the demo site and the v86 stories run, and a simulated one for the rest of Storybook (`DemoAdapter`, `DemoTmux`, and `DemoShell`, a line editor that understands a handful of commands). See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) for the XState architecture.

**tmuxy-tauri-app** — Optional desktop wrapper using Tauri. Communicates via native IPC instead of HTTP, offering lower latency. Each OS window is its own client with its own monitor, in a tmux session group (see "One monitor per GUI window" in [DATA-FLOW.md](DATA-FLOW.md), which also covers the Tauri data flow).

## How They Interact

1. The **frontend** connects to the backend via SSE (web) or Tauri events (desktop) to receive real-time state updates, and sends commands via HTTP POST (web) or Tauri invoke (desktop).

2. The **backend** maintains one `TmuxMonitor` per tmux session. When the first client connects to a session, a monitor is spawned. When the last client disconnects, the monitor shuts down.

3. The **monitor** holds a `ControlModeConnection` — a persistent `tmux -CC attach-session` subprocess. All state-modifying commands go through the control mode stdin connection. See [TMUX.md](TMUX.md) for why this is critical.

4. tmux sends real-time notifications (`%output`, `%layout-change`, `%window-add`, etc.) through control mode stdout. The `StateAggregator` processes these into `StateUpdate` objects (full snapshots or incremental deltas).

5. State updates are emitted via the `StateEmitter` trait — `SseEmitter` broadcasts to all SSE clients in a session, `TauriEmitter` emits Tauri events to the desktop app.

6. The frontend's XState machine merges state updates into its context, and React components re-render via selector hooks. See [DATA-FLOW.md](DATA-FLOW.md) for detailed flow diagrams.

See [ARCHITECTURE-WIDGETS.md](ARCHITECTURE-WIDGETS.md) for this section: Widgets.

## The user's config directory

Everything a user can change lives in `~/.config/tmuxy/` (`$XDG_CONFIG_HOME/tmuxy`), materialized by `tmuxy-core/src/session.rs` at every launch of either host. Two kinds of file live there, and the kind decides what an edit means:

| File | Owner | On launch |
| --- | --- | --- |
| `tmuxy.conf` | user | created once from a template, never touched |
| `custom.css`, `themes/<own name>.css` | user | left alone |
| `tmuxy.defaults.conf`, `tmuxy.essentials.conf` | app | rewritten to this build's copy |
| `themes/<built-in>.css` | app | rewritten, with a header saying so |
| `tmuxy.user.conf` | app | regenerated from the `use-tmux-conf` choice |
| `tmuxy.state.json` | app | choices made in the menus, re-applied after the conf |
| `README.md`, `bin/` | app | rewritten |

The user never overrides what the app bundles; they copy a built-in theme to a new name, write `custom.css`, or set options in `tmuxy.conf`. CSS applies in that order, most specific first: `custom.css` → the `@tmuxy-css-<variable>` options → the theme file. Every edit is live: both hosts watch the directory and either push `css-changed` or source the conf (see [DATA-FLOW.md](DATA-FLOW.md)). The `README.md` written there is the user-facing guide, and the one the bundled agent skill points at.

## Multi-Client Viewport Sizing

Like native tmux, when multiple browser clients connect to the same session, the session is sized to the **smallest client's viewport**. Each client reports its viewport size, the server computes the minimum, and sends a resize command through the monitor's control mode connection. Resize commands must go through control mode — external `tmux resize-window` commands are ignored when a control mode client is attached. Clients of a `--read-only` server are the exception: they report no viewport and draw the session at whatever size its writers gave it, scaled to fit.

## Key Design Decisions

1. **One monitor per session** — Avoids duplicate control mode connections and ensures resize commands work reliably.

2. **All commands through control mode** — External tmux subprocess calls can crash the tmux server when control mode is attached. See [TMUX.md](TMUX.md).

3. **State machine + client model in frontend** — XState owns UI-mode finite states (connecting / idle / reconnecting / disconnected, drag, resize, copy mode, command mode). The tmux world itself lives in a dedicated `TmuxClientModel` (`src/domain/store/`) with explicit committed / pending-ops / derived layers: plain state and pure functions (`src/domain/store/`), held by `src/infra/store/TmuxStore.ts`, whose only effect is sending an op through the `TmuxTransport` service. The appMachine bridges them: every intent is a `TmuxOp` dispatched to `tmuxStoreActor` (`DISPATCH_OP`), and state from the transport stream reaches it as `TMUX_STATE_UPDATE`. Components render; business logic belongs in the machines, and `useEffect` is kept to DOM and timer work that has nowhere else to live.

4. **One transport service** — the `TmuxTransport` Effect service abstracts SSE/HTTP, Tauri IPC and the in-browser engines behind one interface and one ordered event stream, so the frontend is transport-agnostic.

5. **Delta protocol** — After the initial full state snapshot, the server sends incremental deltas (changed panes, windows) to minimize bandwidth.

6. **Adaptive throttling** — The monitor throttles state emissions during high-frequency output (~60fps cap), and emits immediately during low-frequency interactions for responsive typing feedback. Tunables live on `MonitorConfig`.

7. **Sans-IO core, runtime at the edges** — The state aggregator is pure: events in, typed `SideEffect`s out, no I/O of its own. The runtime executes those effects; the aggregator's time-based steps take an explicit instant, so tests can drive it without spinning a real tmux.

8. **One cursor for the whole app** — Each pane still renders a cursor element at its cursor cell, but only as an anchor: it is not painted. The cursor the user sees is a single fixed overlay (`tmuxy-ui/src/components/SmoothCursor.tsx`) that glides to whichever anchor belongs to the pane holding the keyboard, Neovide-style — the corners facing the direction of travel arrive first, the trailing ones lag, so a jump smears and snaps back into a cell. Because the overlay is one element, the same glide covers a move within a pane, a jump between panes, and a jump into the dock or a float. It re-measures the anchor every frame while anything moves, so it also follows transitions running underneath it (a re-tile, a zoom). Only the pane holding the keyboard has an anchor at all; a pane without it draws no cursor in any mode.

## Crate layout

Each crate's source tree is one `ls packages/<crate>/src` away — the durable thing to know is **what each crate owns**, not which files happen to currently exist.

| Crate | Owns |
| --- | --- |
| `tmuxy-core` | `tmux -CC` subprocess management, control-mode event parsing, the sans-IO state aggregator, `TmuxMonitor` runtime, the shared control-mode reads in `transport.rs`, typed `TmuxError`. |
| `tmuxy-server` | Axum HTTP server, SSE streaming with `Last-Event-Id` resync, typed `ClientCommand` enum for the HTTP POST endpoint, per-session client tracking, structured shutdown, embedded frontend assets (prod) or Vite proxy (dev); the `tmuxy server <verb>` tools. |
| `tmuxy-ui` | React frontend, XState machine, optimistic `TmuxClientModel`, Effect-based adapter facade with typed errors, in-browser demo engine, and the v86 client-side adapter (real tmux in an in-browser x86 emulator). |
| `tmuxy-wasm` | wasm-bindgen facade over tmuxy-core's sans-IO control-mode parser + state aggregator, so browsers can reconstruct tmux state with the exact code the native server runs. Build via the root `build:wasm` script. |
| `tmuxy-tauri-app` | Tauri desktop wrapper. Uses the same `TmuxMonitor` plumbing as the server; transport is native IPC instead of SSE/HTTP. |
| `tmuxy-group` | The pane-group operations the `pane-group-*` scripts run (`tmuxy-server group <verb>`), over the rules in `tmuxy_core::groups` — also built as a `tmuxy-group` binary so the v86 guest, which has no server, can run them. |

## Related Documentation

Every doc in this directory, what it covers, and when to read it: [docs/README.md](README.md).
