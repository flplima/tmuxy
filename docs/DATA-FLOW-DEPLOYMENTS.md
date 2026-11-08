# Data Flow: Desktop IPC, Deployments and Endpoints

The Tauri transport, real-world deployment scenarios and the extra HTTP endpoints. Part of [DATA-FLOW.md](DATA-FLOW.md).

## A refused stream is not a dropped one

`EventSource` reports every failure as the same bare error, with no status: a server that is restarting and a server that refuses the request look identical, and retrying the second never ends. So when a stream fails before it ever opened, the adapter asks the same URL with a plain `fetch` and reads the status. A 403 is the request guard's verdict on this page's `Host` or origin (see [SECURITY.md](SECURITY.md)) — the retry loop stops and the reason in the response body is shown as the fatal error. No answer, a 5xx, or a stream that does open are outages, and the supervised retry carries on.

## Transport: Tauri IPC (Desktop Version)

The Tauri desktop app bypasses the network stack entirely:

**`invoke('dispatch', { request: { cmd, args } })`** — Client-to-server commands (equivalent to HTTP POST): the same `{ cmd, args }` the web build posts to `/commands`, handled by the same `tmuxy_core::host::handle`. Only window chrome (the title bar, window size, the Window menu, window styles, restart) has IPC commands of its own. What a host cannot do — the web switching servers or detaching, opening a link on the machine — it answers `unavailable`.

**Tauri events** — Server-to-client events (equivalent to SSE), with the same names and payloads as the SSE frames' (`HostEvent`, `tmuxy-core/src/host/event.rs`): `emit_to(<window label>, "state-update", …)`, addressed to one window rather than broadcast. Both adapters listen through one table (`tmuxy-ui/src/infra/transport/hostEvents.ts`).

Tauri IPC has lower latency than HTTP since communication is in-process.

**One monitor per GUI window.** The desktop app can have several OS windows open on one tmux session (Window ▸ New Window). Each is its own client: its own webview, its own control-mode monitor, and its own tmux session, with the sessions members of one tmux _session group_ — they share every window and pane while each keeps its own current window, which is what puts two tabs of one session on screen at once. The first window holds the group's base session (the one `TMUXY_SESSION` names) and every later one attaches to `<base>+<index>` (`tmux -CC new-session -A -s <base>+2 -t <base>`); a window's session is killed when its window closes, which leaves the shared windows alive in the remaining members. A registry keyed by webview label (`tmuxy-tauri-app/src/windows.rs`) is what turns a command back into the monitor that must run it, so a mutation from window 2 moves window 2's current tab and not the other's. Every event is addressed to the one window whose monitor sent it. A `tmuxy connect` moves every window: they are members of one session group on one server, so the first window takes the target's session and window `N` rejoins it as `<session>+N`.

## Connection Lifecycle (Tauri)

1. App starts, reads `TMUXY_SESSION` env var (defaults to "tmuxy")
2. `host::prepare` checks tmux and lays the config out, then `windows::open_main` starts the first window's monitor
3. On connection failure: exponential backoff (100ms to 10s max); after 5 consecutive failures the monitor **parks** — the loop stays alive but stops retrying until a user-requested reconnect (`tmuxy connect` or the sidebar server picker) revives it. The loop is `host::supervise` in tmuxy-core, shared with the web server; parking, the server switch and the detach are the desktop's `Host` (`packages/tmuxy-tauri-app/src/monitor.rs`), where the web server's stops instead
4. Once connected: emits keybindings, then enters the monitor event loop
5. Frontend's `TauriAdapter.connect()` listens for every host event, then asks for the `greeting` — the `connection-info` and the bindings already read, which went out before the webview listened
6. A `reconnecting` event is the link going down; the next state is it coming back
7. No explicit disconnect — the monitor runs for the window's lifetime; quitting takes every session's last snapshot first

## Deployment Scenarios

Where the monitor and the tmux server sit, and what crosses between them. The network side — what the server listens on, the password, the tunnel, VPN and reverse-proxy set-ups and what never to do — is [SECURITY-NETWORK.md](SECURITY-NETWORK.md); this table only places each scenario.

| Scenario | Client ↔ monitor | Monitor ↔ tmux | Notes |
| --- | --- | --- | --- |
| Desktop app, local tmux | Tauri IPC, in-process | `tmux -CC attach` on this machine | One monitor per GUI window, each on its own session in a shared group (above); no network at all |
| Desktop app, remote tmux over SSH | Tauri IPC | the same control-mode attach, with every tmux argv wrapped as `ssh … tmux …` by `tmux_argv`/`ssh_target` in `packages/tmuxy-core/src/session.rs` (`-tt` for the attach, no tty for one-off reads) | No SSH library: the system `ssh` client, pointed by `TMUXY_SSH` or a saved server's `ssh` field (`servers.json`, [TMUX-CONFIG.md](TMUX-CONFIG.md)). The monitor and `ControlModeConnection` only see a child's stdin/stdout, so the hop is invisible to them; the supervisor's backoff and parking apply unchanged |
| `tmuxy server` on a remote machine, browser client | SSE + `POST /commands` over HTTP; no TLS of its own | local | Plain `tmuxy server` listens on loopback only; a routable `--host` needs a password or `--no-auth`, and belongs behind an SSH tunnel, a VPN or a TLS proxy ([SECURITY-NETWORK.md](SECURITY-NETWORK.md) § Deployment Recommendations). Any number of tabs and devices attach at once, the viewport settled by `@tmuxy-size`; a phone gets the phone layout ([PHONE.md](PHONE.md)). The only file the server reads for a client is a preview's document, authorised by the pane's option and confined to that document's folder ([SECURITY-CONTENT.md](SECURITY-CONTENT.md)). No local echo ([NON-GOALS.md](NON-GOALS.md)) |
| No server: real tmux in the browser | the guest driver, in-page | the guest's `tmux -CC` on its UART or console | Below |

### Fully client-side: real tmux in the browser (v86 or CheerpX + wasm)

No server at all. Real tmux runs inside an in-browser guest machine, and its `tmux -CC` control-mode stream is parsed by **tmuxy-core compiled to WebAssembly** — the same Rust parser and state aggregator the native server runs. Two guests share everything but the machine:

- **v86** — an x86 emulator running a small buildroot Linux restored from a pre-booted state snapshot; the control client is on its UART.
- **CheerpX** — an x86-to-WebAssembly JIT running 32-bit Alpine binaries from an ext2 image streamed over HTTP; the control client is on its console, through the guest's `tmuxy-console` relay. Faster and with no kernel to boot, but it needs a cross-origin isolated page (COOP + COEP headers), and its kernel lacks enough that the guest's tmux is patched and every pane runs under `tmuxy-pty` (see `packages/tmuxy-ui/cheerpx/README.md`).

Both guests carry the `tmuxy` CLI and its scripts, the config the app ships, and `tmuxy-verbs` in place of a server: the CLI's Rust verbs (floats, tabs, `run`, sends, pane groups, config, agents) cross-compiled for i686-musl from `tmuxy-verbs` without its `native` feature (`packages/tmuxy-ui/scripts/lib/guest.mjs`). A command that needs the server (`session save|restore|…`, `session connect`, `plugin`, `trace`) answers there as not available, under the CLI's contract.

```
TmuxyApp ──run(op)──> GuestTmuxAdapter ──> GuestEngine (V86Engine | CheerpXEngine)
   ▲                                                              │ send
   │                                                              ▼
onStateChange <── tmuxy-wasm (MonitorCore) <──stream── tmux -CC in the guest
```

Key pieces (under `tmuxy-ui/src/infra/transport/drivers/`):

| Piece | Responsibility |
| --- | --- |
| `guest/GuestEngine` | The machine-independent host of the wasm client core (`MonitorCore`, the native monitor's own: the attach commands, reply correlation and timeouts, the `run-shell` relay, the re-list timers, window sizing, `%exit`, with its reads paced to one batch on the wire at a time): it feeds the stream in, ticks the core, runs the commands it hands back, keeps the callers' replies by id (`infra/transport/drivers/guest/controlMode.ts`), and serializes the boot/reset lifecycle — invariant A12 in INVARIANTS.md. |
| `guest/GuestTmuxAdapter` | The driver behind `GuestTransportLive`: routes a client's commands and queries through the router every transport uses (a wasm export of `command_router`), serves themes/keybindings/images locally. The first frame is the finished start: the session is sized to the client's viewport before the first state is answered, as the server does, and an init whose work outlives its commands (a shell line it typed) names a tmux option it sets when done (`initDoneOption`), which `connect()` waits for. Files the page hands it (`files`: text, or a URL it fetches) are in the guest's `/mnt` before the init runs: v86's 9p share, a CheerpX in-memory device mounted at the same path. |
| `v86/V86Engine` | The v86 machine: a UART writer paced under the rate the guest drains its input (v86's UART queue is unbounded; the guest reads ~45 KB/s, and a slower pace turns the queue into the bottleneck behind every keystroke) and serial coalescing. Snapshot restores rewind the filesystem, so the guest setup is re-applied on every attach. |
| `v86` shared engine | Opt-in: many adapters reuse one booted machine; each consumer restores the pinned snapshot with a fresh WASM core (~1s) instead of cold-booting (~5s). Each restore zeroes v86's TSC offset first (`restoreSnapshot`, `infra/transport/drivers/v86/v86Guest.ts`): v86 sets the saved TSC right only at offset zero, so a second restore froze the guest's clock for 99s. |
| `cheerpx/CheerpXEngine` | The CheerpX machine: CheerpX from its CDN, the image with a fresh IndexedDB overlay per page load, the relay on the console. |

The public demo site (`packages/tmuxy-demo`) runs CheerpX where the page is cross-origin isolated and v86 elsewhere; `?guest=v86` asks for v86. Its dev server sends the isolation headers; GitHub Pages, which hosts the static export, cannot, so a service worker adds them to the site's own responses (`packages/tmuxy-demo/public/coi-sw.js`), reloading a page it does not serve yet (a first visit, a hard reload) once to put it under the worker. A browser without service workers gets v86. The Storybook `v86` stories run v86. Assets (kernel, BIOS, state snapshot, ext2 image, wasm bindings) are served statically; nothing leaves the browser.

The v86 guest is CI-tested: the `storybook-v86-probe` job builds the wasm bindings and guest assets (the `v86-guest` action, cached on everything the guest is built from: its build scripts, the CLI and shipped confs, and the `tmuxy-verbs` it cross-compiles), starts a Storybook dev server, and drives the gate stories on one shared page (`tmuxy-ui/scripts/probe-spikes.mjs`); every `v86`-tagged story runs nightly in `nightly-v86.yml`. The deterministic stories run in the parallel `storybook-probe` job. See `docs/TESTS.md` § Storybook Tests. The CheerpX guest has no automated test yet.

## Additional API Endpoints

Beyond the core SSE/HTTP protocol, the web server exposes:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/events` | GET | SSE stream (state updates, connection info) |
| `/commands` | POST | tmux commands (no authentication unless `--password` is set — see SECURITY.md) |
| `/mcp` | POST | The MCP endpoint, one JSON-RPC message per request ([MCP.md](MCP.md)) |
| `/trace` | POST | A browser client's trace events, appended to the server's trace file ([TRACING.md](TRACING.md)) |
| `/api/images/{pane_id}/{image_id}` | GET | Serve a decoded inline-image blob |
| `/api/preview/{pane_id}` | GET, POST | A preview pane's composed page: POST stages it, GET serves it with the page's own policy header ([ARCHITECTURE-WIDGETS.md](ARCHITECTURE-WIDGETS.md)) |
| `/api/push` | GET | The server's web-push public key |
| `/api/push/subscription` | POST, DELETE | A device turning notifications on or off (`tmuxy-server/src/push.rs`) |
| `/themes/{name}.css`, `/custom.css` | GET | The user's stylesheets from the config dir; a theme the user has not got, or not under that name, is the bundled built-in |

The API routes (`tmuxy-server/src/state.rs`, `api_routes`) all sit behind the same origin rules (`request_guard.rs`); everything else falls through to the embedded frontend, or to the Vite proxy in dev mode.

The stylesheet routes are answered by `tmuxy_core::session::resolve_user_css` in both builds: the web server serves them at the app's origin (ahead of the embedded bundle, and ahead of the Vite proxy in dev mode), the desktop app over its `tmuxycss:` scheme, and `tmuxy-ui/src/infra/themeManager.ts` picks between the two. Both hosts poll the config dir once a second (`tmuxy_core::host::start`, the start-up both run): a saved stylesheet becomes a `css-changed` push, a saved `tmuxy.conf` sources the config chain (`tmuxy.entry.conf`) on the control-mode connection, puts back the menu choices the file does not pin, and is followed by the `keybindings` and `theme-settings` pushes a client's own `source-file` gets. `tmuxy config reload` is that second path — it touches a marker in the state dir that the same poll watches, and nothing more, so it writes nothing into the config dir and works without a `tmuxy.conf`. See [ARCHITECTURE.md](ARCHITECTURE.md) for what each directory holds.

Every route is gated by the optional `--password` Basic auth. See [SECURITY.md](SECURITY.md).
