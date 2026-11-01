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

**tmuxy-ui** — React frontend using XState for all state management. Reaches the backend through the `TmuxTransport` Effect service (one Layer per transport). Includes in-browser engines, `V86TmuxAdapter` and `CheerpXTmuxAdapter` — real tmux and bash in an x86 emulator or under CheerpX's x86-to-wasm JIT, the control-mode stream parsed by tmuxy-core compiled to wasm — which the demo site and the v86 stories run. The rest of Storybook replays states recorded from real tmux (`src/stories/fixtures/`). See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) for the XState architecture.

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

tmuxy's files live in three directories, split by owner so each has one rule (`Layout` in `tmuxy-core/src/session/config.rs`, the directories in `tmuxy-core/src/paths.rs`):

| Dir | Default | Owner | Rule |
| --- | --- | --- | --- |
| config | `~/.config/tmuxy` (`$XDG_CONFIG_HOME/tmuxy`) | user | written once, on the very first run; safe to edit and to symlink from a dotfiles repo |
| data | `~/.local/share/tmuxy` (`$XDG_DATA_HOME/tmuxy`, `TMUXY_DATA_DIR`), on every OS | app | mirrored from the bundle on every launch, read-only, never written through a symlink |
| state | `~/.local/state/tmuxy`, macOS `~/Library/Application Support/tmuxy` (`TMUXY_STATE_DIR`) | app | this machine's state; never shared between machines |

| File | Dir | Owner | On launch |
| --- | --- | --- | --- |
| `tmuxy.conf` | config | user | the starter (comments only) on the very first run — the config dir did not exist, not even as a dangling link — and never again |
| `custom.css`, `themes/<name>.css` | config | user | left alone; a theme named like a built-in shadows it |
| `tmuxy.defaults.conf`, `tmuxy.essentials.conf`, `tmuxy.conf.example`, `README.md` | data | app | rewritten to this build's copy, headed as generated |
| `themes/<built-in>.css`, `bin/` | data | app | rewritten, headed as generated; a retired built-in is removed |
| `tmuxy.entry.conf` (and `tmuxy.compat.conf`, when needed) | data | app | rebuilt before every use: the config chain (see [TMUX-CONFIG.md](TMUX-CONFIG.md#the-config-chain-and-where-a-users-own-tmuxconf-fits)) |
| `tmuxy.state.json`, `trace.json`, `servers.json` | state | app | written when the menus, the Debug menu or `tmuxy session connect` change them |
| `launcher`, `tmuxy.pid`, `config-reload` | state | app | the desktop app's path for the `~/.local/bin/tmuxy` shorthand; the web server's pid; the marker `tmuxy config reload` touches |

The user never overrides what the app bundles; they copy a built-in theme into the config dir (under a new name to add one, the same name to replace it), write `custom.css`, or set options in `tmuxy.conf`. CSS applies in that order, most specific first: `custom.css` → the `@tmuxy-css-<variable>` options → the theme file. An option `tmuxy.conf` sets beats a menu choice (see [TMUX-CONFIG.md](TMUX-CONFIG.md#menu-choices-and-the-options-tmuxyconf-pins)). Every edit is live: both hosts watch the config dir and either push `css-changed` or source the chain (see [DATA-FLOW.md](DATA-FLOW.md)). The `README.md` in the data dir is the user-facing guide, and the one the bundled agent skill points at; `tmuxy config paths` lists every file with its owner and its real location.

**Migration.** The first launch of a build with this layout (`tmuxy-core/src/session/migrate.rs`) moves an older install's state files out of `~/.config/tmuxy` into the state dir, removes the files it used to mirror there (the confs, the README, `bin/`, the built-in themes it headed), and drops from `tmuxy.conf` the blocks older builds wrote: the template header, the `source-file …/tmuxy.defaults.conf` line, the commented examples, the Ctrl+Tab lines "added by tmuxy upgrade" and a Ctrl+hjkl restore the defaults ship again — keeping the original as `tmuxy.conf.bak`. Only comments, that line, and bindings identical to ones the defaults ship go, and a binding only when no other line binds or unbinds the same key. Nothing is written or deleted through a symlink: a linked config dir is only read (its state files are copied), and a linked `tmuxy.conf` is reported in the log rather than rewritten. A second run finds nothing to do. Pid files an older build left in `~/.tmuxy` are still read by `tmuxy server stop` and `status`.

## Multi-Client Viewport Sizing

Each client reports the viewport its pane container holds, in cells of the font it measures. The server sizes the session from those reports by the config's `@tmuxy-size` and sends the resize through the monitor's control-mode connection (external `tmux resize-window` commands are ignored while a control-mode client is attached). The policy is parsed in `tmuxy-core/src/client_size.rs`, read with the appearance options, and applied in `tmuxy-server/src/sse/clients.rs`.

| `@tmuxy-size` | the session is | clients draw it |
| --- | --- | --- |
| `smallest` (default) | the smallest viewport, like native tmux | at their measured cell; a larger client leaves blank space |
| `largest` | the largest viewport | a smaller client scales the grid down to fit |
| `latest` | the viewport of the client used last: the last to send a command or report a new size | a smaller client scales down to fit |
| `COLSxROWS` (`80x25`) | that grid, whatever the clients report | every client scales the grid to fill its container, up or down |

The scaling is the client's: `fittedGridCell` (`tmuxy-ui/src/machines/app/helpers.ts`, over `utils/gridFit.ts`) fits the measured cell to the grid, the same way the phone layout fits 80 columns, and the pane container carries the fitted font. The chrome and the sidebar columns keep the measured cell. Under a fixed size a client also asks for that size, so opening a sidebar re-tiles nothing: in a browser the grid shrinks into the room left, and the desktop app instead widens the OS window by the column (`grow_window`, as far as the screen allows) and narrows it back when the column closes.

A report is taken no smaller than a floor (`MIN_CLIENT_COLS` × `MIN_CLIENT_ROWS` in `client_size.rs`): a grid that measured as a sliver mid-load, or a forged size, must not shrink the session to nothing for every other client under `smallest`.

The desktop app has one client per window, so only a fixed size changes anything there.

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
| `tmuxy-ui` | React frontend, XState machine, optimistic `TmuxClientModel`, Effect-based adapter facade with typed errors, and the v86 client-side adapter (real tmux in an in-browser x86 emulator). |
| `tmuxy-wasm` | wasm-bindgen facade over tmuxy-core's sans-IO control-mode parser + state aggregator, so browsers can reconstruct tmux state with the exact code the native server runs. Build via the root `build:wasm` script. |
| `tmuxy-tauri-app` | Tauri desktop wrapper. Uses the same `TmuxMonitor` plumbing as the server; transport is native IPC instead of SSE/HTTP. |
| `tmuxy-group` | The pane-group operations the `pane-group` script runs (`tmuxy-server group <verb>`), over the rules in `tmuxy_core::groups` — also built as a `tmuxy-group` binary so the v86 guest, which has no server, can run them. |
| `tmuxy-pty` | The terminal each pane of the CheerpX guest runs on: CheerpX gives every process one pty, so the guest's patched tmux runs a pane on a socket pair under this helper, which does the line discipline, and its LD_PRELOAD (`preload.c`) supplies the process-group behaviour CheerpX lacks. See `packages/tmuxy-ui/cheerpx/README.md`. |

## Related Documentation

Every doc in this directory, what it covers, and when to read it: [docs/README.md](README.md).
