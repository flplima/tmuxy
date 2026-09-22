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

## Widgets

A **widget** is a React component rendered *in place of* a pane's terminal. The pane is a real
tmux pane running a real process — it can be focused, navigated into, resized and closed like any
other — but what it draws is a component, not cells.

A pane declares itself a widget by printing a marker line: `__TMUXY_WIDGET__:<name>`, which
`bin/tmuxy/tmuxy-widget` emits before passing stdin through. The frontend scans pane content for
it (`components/widgets/index.ts`), and everything the pane prints after the marker is the
widget's content — the channel a widget's script uses to hand it a payload. The process must stay
alive; closing the pipe fires the wrapper's EXIT trap, which clears the marker and hands the pane
back to a shell. That is what ctrl+c in a widget pane does.

| Widget | Started by | Content it reads |
|--------|-----------|------------------|
| `browser` | `tmuxy widget browser [--color-filter] <file\|url\|->` | `__SRC__:<path or url>` — one source: an HTML file, a website, a markdown file (rendered, mermaid included), or an image. `--color-filter` writes `__COLOR_FILTER__` first, and a page or image is then recoloured into the theme: each pixel's luminance is looked up in a ramp of the theme's own tones, **darkest first**, so the page keeps its polarity — full black lands on the theme's darkest tone (gruvbox's `#282828`), full white on its lightest (`utils/themeColorFilter.ts`). Ordering the ramp by ROLE instead (ink → foreground, paper → background) inverted every page on a dark theme, which is why the stops are sorted by tone: `--term-background` is the dark end of a dark theme and the light end of a light one. A framed page is recoloured by a **backdrop filter on a sheet laid over the frame**, not by a `filter` on the frame: a filter on an iframe repaints only the element's own background and stops at the document boundary, leaving the page inside untouched. An image, being in the app's own document, takes a plain `filter`. Markdown is already drawn in theme colours. Under the pane header it draws an **address bar** (`BrowserNav.tsx`): back, forward, refresh, the address, and a hand-off to the system browser — see below for what its history is |
| `tree` | `tmuxy widget tree` | none — the tabs/panes tree is derived from state the app already holds |
| `session` | `tmuxy widget session` | none — the sessions come from the same poll the tree uses, the servers from `list_servers`. Switch, rename, kill or detach the session, and attach to another tmux socket locally or over SSH. What the DETACHED overlay shows, which is the way back in when there is no session to draw behind it. Everyday switching is the `SessionMenu` dropdown instead: a menu costs no tmux window, and switching is a one-line question |

### A pane group's header

A group shares one header between its members: each gets an equal share of the width, its title at the left of that share and its own ⋮ and ✕ at the right, with the member not in view dimmed by a darker ground. One pair of buttons for the whole strip belonged to whichever member happened to be showing — unguessable from looking, and with no way at all to close a PARKED member, which is the one thing per-member controls make possible. An ungrouped pane keeps the plain shape: one title across the header and its buttons at the header's own right edge.

### The browser's address bar, and whose history it is

Back and forward walk the places the PANE has been pointed — its `__SRC__` marker, then whatever was typed into the bar — held per pane in `browserStates[paneId]` as `history` + `historyIndex`. They are not the page's history, and the address is not necessarily the page's address: the frame is a separate document and, for a website, a separate origin, so neither its current URL nor its navigations can be read from the app. A bar that claimed otherwise would be wrong the first time anyone clicked a link inside the page; this one shows a thing the app actually knows.

Typing an address goes through `normalizeAddress` (`widgets/browser/view.ts`), which gives a bare host the scheme the user meant and leaves a path or an explicit scheme alone — the widget shows local files as readily as websites. Two shapes need telling apart by hand there: `localhost:3000` matches the scheme pattern but is a host and a port, and a loopback host gets `http` rather than `https`, since a dev server is rarely serving TLS and an iframe cannot fall back from a failed load the way a browser can.

**The pane's name** is the page's own `<title>` where the app may read it, and the address otherwise — the order a browser tab uses. Reading it means fetching the HTML: the frame cannot be asked (a local page runs in an opaque origin, a website is another origin, so `contentDocument` is null by design), but the bytes can be fetched for a local file through tmuxy's file route, or for a page the app itself serves. A cross-origin site is left alone — not only because the request would fail, but because firing one that is certain to fail logs a CORS error per page and gains nothing (`widgets/browser/pageTitle.ts`).

A pane PARKED in a pane group is the exception, and it is a tmux one: a stash member streams no content, so there is no widget and no page to read a title from — all a group's tab strip has for it is tmux's `pane_title`. `bin/tmuxy/tmuxy-widget` therefore announces one over OSC 2 when a widget starts (the browser passes its file name), so a parked member reads as `notes.html` rather than as the CLI's own path, and hands the title back on exit.

The hand-off to the system browser is `utils/openUrl.ts` (the desktop asks its Rust side, the web build opens a tab), and it only ever takes http(s)/mailto — so the button is disabled for a local file, with a tooltip saying why, rather than silently doing nothing.

### A widget that embeds a page

The `browser` widget renders its page in an `<iframe>`, and an iframe is a hole in the app's event
surface: every pointer event inside it belongs to that document, so the app sees none of them. Two
things therefore do not come for free, and both have to be arranged around the frame rather than
inside it.

**Activating the pane.** No mousedown reaches the pane wrapper, so the click that should make the
pane active never arrives. Focus is the one signal that does cross the boundary — clicking into a
frame blurs the parent window and makes that `<iframe>` the parent document's `activeElement` — and
`hooks/useFramedPaneFocus.ts` reads it there. The click still reaches the page, so one gesture both
focuses the pane and presses the button under the cursor, the way a terminal pane already behaves
(`usePaneMouse` focuses unconditionally and forwards the same event). A shield over an inactive
frame would instead cost a first click and take wheel scrolling away from an unfocused pane.

**Dragging over it.** A divider drag and a pane drag both run on `mousemove`/`mouseup` listeners on
`window`, which stop arriving the moment the cursor crosses into a frame: the divider froze, and the
release was swallowed too, leaving the app stuck in a resize until some later click landed outside a
frame. `WidgetPane` therefore sets `pointer-events: none` on its content for the length of a drag or
a resize (`useIsDragging` / `useIsResizing`) — nothing inside a pane needs the pointer while the app
is already using it.

A widget registers a **definition**, not just a component, so it can furnish the parts of the pane
chrome it does not own: its tab `icon`, a `selectTitle` for the tab (the browser names its pane
after the page it is showing), a `selectMenuItems` section that leads the pane's ⋮ menu, and an
`onKeyDown` for keys it claims before they reach tmux. Each is a pure function of machine context
plus the pane's widget content, so a menu that is not the widget's own child can still ask the
widget what it can currently do. Adding a widget means writing a definition and registering it in
`components/widgets/init.ts`; no shared component needs to learn its name.

Widget state that outlives a render — the browser's per-pane history and zoom — lives in the app
machine's `browser` parallel state rather than in the component, so the menu and the pane read the
same source of truth. See [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md).

## Multi-Client Viewport Sizing

Like native tmux, when multiple browser clients connect to the same session, the session is sized to the **smallest client's viewport**. Each client reports its viewport size, the server computes the minimum, and sends a resize command through the monitor's control mode connection. Resize commands must go through control mode — external `tmux resize-window` commands are ignored when a control mode client is attached. Clients of a `--read-only` server are the exception: they report no viewport and draw the session at whatever size its writers gave it, scaled to fit.

## Key Design Decisions

1. **One monitor per session** — Avoids duplicate control mode connections and ensures resize commands work reliably.

2. **All commands through control mode** — External tmux subprocess calls can crash the tmux server when control mode is attached. See [TMUX.md](TMUX.md).

3. **State machine + client model in frontend** — XState owns UI-mode finite states (connecting / idle / reconnecting / disconnected, drag, resize, copy mode, command mode). The tmux world itself lives in a dedicated `TmuxClientModel` (`src/tmux/store/`) with explicit committed / pending-ops / derived layers, owned by an Effect-managed Ref. The appMachine bridges them by routing `SEND_TMUX_COMMAND` and `TMUX_STATE_UPDATE` through `tmuxStoreActor`. React components remain purely presentational — no `useEffect` side effects.

4. **Adapter pattern for transport** — `TmuxAdapter` interface abstracts SSE/HTTP vs Tauri IPC, making the frontend transport-agnostic.

5. **Delta protocol** — After the initial full state snapshot, the server sends incremental deltas (changed panes, windows) to minimize bandwidth.

6. **Adaptive throttling** — The monitor throttles state emissions during high-frequency output (~60fps cap), and emits immediately during low-frequency interactions for responsive typing feedback. Tunables live on `MonitorConfig`.

7. **Sans-IO core, runtime at the edges** — The state aggregator is pure: events in, typed `SideEffect`s out, no I/O of its own. The runtime executes those effects against a substitutable `Ctx` (clock / tmux / filesystem trait objects). Tests can drive the aggregator without spinning a real tmux.

8. **Policy as data** — Retry and timeout for async tmux dispatch are values, not hard-coded constants. They flow through a Tower middleware stack (`TraceLayer → RetryLayer → TimeoutLayer → TmuxService`) with one composition point in code.

9. **One cursor for the whole app** — Each pane still renders a cursor element at its cursor cell, but only as an anchor: it is not painted. The cursor the user sees is a single fixed overlay (`tmuxy-ui/src/components/SmoothCursor.tsx`) that glides to whichever anchor belongs to the pane holding the keyboard, Neovide-style — the corners facing the direction of travel arrive first, the trailing ones lag, so a jump smears and snaps back into a cell. Because the overlay is one element, the same glide covers a move within a pane, a jump between panes, and a jump into the dock or a float. It re-measures the anchor every frame while anything moves, so it also follows transitions running underneath it (a re-tile, a sidebar sliding). Only the pane holding the keyboard has an anchor at all; a pane without it draws no cursor in any mode.

## Crate layout

Each crate's source tree is one `ls packages/<crate>/src` away — the durable thing to know is **what each crate owns**, not which files happen to currently exist.

| Crate             | Owns                                                                                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmuxy-core`      | `tmux -CC` subprocess management, control-mode event parsing, the sans-IO state aggregator, `TmuxMonitor` runtime, substitutable `Ctx` (clock/tmux/fs), retry policy, Tower middleware stack, typed `TmuxError`.           |
| `tmuxy-server`    | Axum HTTP server, SSE streaming with `Last-Event-Id` resync, typed `ClientCommand` enum for the HTTP POST endpoint, per-session client tracking, structured shutdown, embedded frontend assets (prod) or Vite proxy (dev). |
| `tmuxy-ui`        | React frontend, XState machine, optimistic `TmuxClientModel`, Effect-based adapter facade with typed errors, in-browser demo engine, and the v86 client-side adapter (real tmux in an in-browser x86 emulator).            |
| `tmuxy-wasm`      | wasm-bindgen facade over tmuxy-core's sans-IO control-mode parser + state aggregator, so browsers can reconstruct tmux state with the exact code the native server runs. Build via the root `build:wasm` script.           |
| `tmuxy-tauri-app` | Tauri desktop wrapper. Uses the same `TmuxMonitor` + `Ctx` plumbing as the server; transport is native IPC instead of SSE/HTTP.                                                                                            |
| `tmuxy-connect`   | Standalone TUI for the "add a server" form (`tmuxy connect`), which the desktop app opens in a float. `bin/tmuxy-cli` prefers this binary when present.                                                                    |
| `tmuxy-tree`      | Standalone TUI browser of the sessions→tabs→panes tree (`tmuxy tree`), for a plain terminal — packaged separately so the v86 guest can run it. `bin/tmuxy-cli` prefers this binary when present. It spans every session on the socket, which is what makes it useful with no app around it; the left sidebar's React tree (`tmuxy widget tree` — see [Widgets](#widgets)) is scoped to the attached session instead, since that is the one the app holds state for.                                                 |

## Related Documentation

Every doc in this directory, what it covers, and when to read it: [docs/README.md](README.md).
