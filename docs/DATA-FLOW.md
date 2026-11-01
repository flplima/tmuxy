# Data Flow

This document describes how data moves through tmuxy in different deployment scenarios, covering the SSE/HTTP protocol, Tauri IPC, and real-world use cases.

## Transport: SSE/HTTP (Web Version)

The web version uses two HTTP endpoints on the Axum server:

**`GET /events?session=<name>`** — Server-Sent Events stream (server-to-client):

- `connection-info` — Connection ID, default shell, and whether the server is tracing (sent on connect)
- `keybindings` — Prefix key and all key bindings from tmux config
- `theme-settings` — Theme name/mode, appearance (surface opacities, blur flag) and the `@tmuxy-css-*` variables from tmux config; re-sent after a `source-file`, and after the server itself sources a saved `tmuxy.conf`
- `css-changed` — A stylesheet under the user's config dir (`themes/*.css`, `custom.css`) was saved; the client re-fetches its stylesheets and the themes list. No payload
- `state-update` — Full state snapshots and incremental deltas (serialized JSON)
- `clipboard` — OSC 52 clipboard payloads forwarded from terminal applications
- `tmux-message` — `{ text }`, a `display-message` tmux showed this client (its `%message` notification), shown in the snackbar. Named `tmux-message`, never `message`: that is `EventSource`'s default event type, which `onmessage` receives too. The desktop app emits the same name.
- `ping` — keepalive on an idle stream, once a second; the client times a silent link out by it (see Reconnecting below)
- `log`, `tmux-error`, `fatal` — Diagnostic and error notifications. The error event is named `tmux-error`, never `error`: the browser hands a server event called `error` to `EventSource.onerror` too, and the adapter would treat every reported error as a dropped connection.

**`POST /commands?session=<name>`** — HTTP POST (client-to-server):

- Request body: `{ "cmd": "command_name", "args": {...} }`
- Response: `{ "result": ... }` or `{ "error": "message" }`
- **Loopback by default** — a routable `--host` needs an HTTP Basic password (or an explicit `--no-auth`), and every API route refuses requests from other origins — see [SECURITY.md](SECURITY.md).

SSE was chosen over WebSocket because: server-to-client is the dominant direction, `EventSource` has built-in browser reconnection, SSE works through all proxies/CDNs, and the standard `Last-Event-Id` mechanism gives us a clean reconnect path (see below).

### Reconnecting

The adapter reopens a dropped stream on an exponential backoff (1s, 2s, 4s … capped at 30s), and three rules keep that from turning into a long wait on a link that drops often and briefly — a laptop waking, a Wi-Fi roam:

- **The backoff belongs to one outage.** A connection that was established and then dropped starts the next one on a fresh schedule, after a short beat. One schedule for the page's whole life only climbs, and a few drops in every reconnect waited out the cap.
- **A reason to retry now beats the timer.** The browser's `online` event, the tab becoming visible, and the overlay's _Retry now_ button (`RECONNECT_NOW` → `adapter.reconnectNow()`) all abandon the current wait and try immediately. None of them does anything while connected.
- **Silence is a drop.** The server's keepalive is a named `ping` event rather than an SSE comment (a page never sees comments), sent whenever the stream has been idle for a second. Once a client has seen one, five seconds without any event ends the connection — a link that dies without an error is otherwise noticed minutes later, if at all. A server that sends no pings is never timed out.

### A refused stream is not a dropped one

`EventSource` reports every failure as the same bare error, with no status: a server that is restarting and a server that refuses the request look identical, and retrying the second never ends. So when a stream fails before it ever opened, the adapter asks the same URL with a plain `fetch` and reads the status. A 403 is the request guard's verdict on this page's `Host` or origin (see [SECURITY.md](SECURITY.md)) — the retry loop stops and the reason in the response body is shown as the fatal error. No answer, a 5xx, or a stream that does open are outages, and the supervised retry carries on.

### SSE resync via `Last-Event-Id`

Every event the server broadcasts is tagged with a monotonic per-session sequence id (set as the SSE `id:` field). `EventSource` persists the last received id across reconnects and sends it back as the `Last-Event-Id` request header on retry. The server keeps a small ring buffer of recent events per session — the last 128, within 16 MB (`EVENT_BUFFER_SIZE`, `EVENT_BUFFER_MAX_BYTES` in `tmuxy-server/src/state.rs`) — and replays everything strictly newer than the supplied id before resuming the live stream. If the client's id is older than the buffer head (a long disconnect, or a burst of large deltas that outran the byte budget), nothing is replayed: the first live delta's `seq` does not follow the client's last one, and the sequencer refetches a full state — no client-side panic, no data corruption.

This is independent from the delta protocol's own `seq` field: the SSE id keeps the _transport_ in sync after a reconnect; the delta `seq` keeps the _application state_ in sync after each individual update.

See [DATA-FLOW-DEPLOYMENTS.md](DATA-FLOW-DEPLOYMENTS.md) for these sections: Transport: Tauri IPC (Desktop Version); Connection Lifecycle (Tauri); Real-World Deployment Scenarios; Additional API Endpoints.

## Adapter Pattern

The frontend reaches tmux through one Effect service, `TmuxTransport` (`tmuxy-ui/src/infra/transport/TmuxTransport.ts`): `connect`/`disconnect`, `invoke` for commands (fire-and-forget `run_tmux_command` among them), `query` for read-only tmux commands answered in-band on the control-mode connection — each failing with a typed `AdapterError` — and `subscribe`, one ordered `Stream` of tagged transport events (state, connection info, reconnection, keybindings, theme settings, logs, errors, fatal, detach, clipboard), so the first state never overtakes the connection info it depends on. Four Layers provide it (`layers.ts`): HTTP/SSE and Tauri IPC, which share one stream stage (`stateFeed.ts`: decode, sequence, and on a gap or an undecodable payload refetch the full state once at the last viewport the client reported), and the in-browser demo and v86 engines. Each Layer wraps a driver under `drivers/` whose events go through one generic hub (`infra/eventHub.ts`). The app builds one `ManagedRuntime` from the Layer for its environment (`infra/runtime.ts`), and the XState actors run every effect on it; tests swap in a scripted driver behind the real Layer (`src/test/transport.ts`).

## Connection Lifecycle (Web)

1. Client opens SSE connection: `GET /events?session=<name>`
2. Server assigns a unique `connection_id`
3. Server checks if a `TmuxMonitor` exists for the session:
   - **No monitor:** Spawns a new monitor (connects `tmux -CC`), stores handle in `SessionConnections`
   - **Has monitor:** Subscribes to the existing broadcast channel and replays from the ring buffer if the client supplied a `Last-Event-Id`
4. Client receives `connection-info` event with connection ID and default shell
5. Client sends `get_initial_state` (via HTTP POST) with its viewport size (cols, rows)
6. Server stores the client size, computes the minimum viewport across all clients, and sends a resize command through the monitor's control mode connection
7. Client receives full state snapshot, then incremental deltas as tmux state changes. The stream (one full state, then deltas against the server's previous emission) is the client's state from its first full state on; the `get_initial_state` answer is a separate snapshot, so once the stream is synced it only fills panes the stream has not sent content for yet. It is the starting state only before the stream's first full state, after a delta sequence gap, or on a new connection (`adoptInitialState` in `tmuxy-ui/src/domain/deltaProtocol.ts`).
8. On disconnect: server removes the client, recomputes minimum viewport, and shuts down the monitor if no clients remain

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

Reads go the same way: scrollback, key bindings, theme settings and snapshot checks are command lists answered in-band by the monitor (`tmuxy-core/src/transport.rs`, shared by both transports). Sync helpers in `executor::*` remain only for CLI paths with no client attached.

**Two operations, the same on every transport.** `run_tmux_command` is a mutation: it is handed to the monitor's control-mode channel fire-and-forget and resolves to `null` — the result of a control-mode command arrives later as a state event, not as the response. `query_tmux` is a read: the monitor brackets the command with marker lines, collects the `%begin…%end` blocks between them, and answers with what the command printed (`MonitorCommand::RunCommandWithReply`); a tmux `%error` rejects the call with tmux's message. A mutation is bracketed the same way, with nobody waiting for the output: when tmux answers it with `%error`, the monitor emits the message as an error event (`SseEvent::Error` / `tmux-error`), which the frontend shows in the snackbar — the only way the user learns why a split or a kill did nothing. Keystrokes (`send-keys`, pinned or not) are the exception and go out bare: one command per key, and the only way they fail is a pane that is already gone from the layout. Web (`ClientCommand::QueryTmux`) and desktop (the `query_tmux` Tauri command) implement both identically, and the frontend reaches them as `adapter.invoke('run_tmux_command', …)` and `adapter.query(command)`. There is no subprocess path. A query runs only tmux's reads (`command_router::route_query`): a command list with anything else in it — a `run-shell`, a `kill-pane` after a `;` — is refused as `forbidden`, because a mutation belongs on the mutation path, behind the queue and the `run-shell` relay. That is not an access boundary: the same client may send it as a mutation.

**Failures carry a kind.** A failed command answers `{ "error": "<message>", "kind": … }` on both transports (the HTTP body of `POST /commands`, the object a Tauri command rejects with): `tmux` when tmux itself refused it (a query answered with `%error`), `unavailable` (no monitor, session or channel; a timeout), `invalid` (a malformed payload or id) and `forbidden` (a blocked command). The client maps `tmux` to `TmuxError` and the rest to `TransportError` (`tmuxy-ui/src/infra/transport/AdapterError.ts`). See `tmuxy_core::CommandError`.

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
│         └──────────┬───────────┘         │
│                    ▼                     │
│      command_router::route_command       │
│                    │                     │
│     monitor channel (mutations and       │
│     in-band reads, transport.rs)         │
└────────────────────┬─────────────────────┘
                     ▼
            Monitor stdin → tmux
```

## Delta Protocol

After the initial full state snapshot, the server sends incremental deltas to minimize bandwidth:

- Each delta has a `seq` number for ordering; a full state and the `get_initial_state` answer carry the `seq` they were taken at, so the delta right after either one is checked against it
- Deltas contain only changed fields: modified panes (content, cursor, metadata), added/removed panes, added/removed windows, active pane/window changes, status line changes
- The frontend merges deltas into its cached state via `handleStateUpdate()` in `tmuxy-ui/src/domain/deltaProtocol.ts`
- If a delta arrives with a sequence gap, the client requests a full state resync

## Keyboard Input Flow

1. User presses a key in the browser
2. `keyboardActor` captures the DOM `keydown` event. A hidden text input (`tmuxy-ui/src/utils/mobileKeyboard.ts`) owns browser focus on every device and follows the pane holding the keyboard (pane, float, or dock); an IME can only begin a composition inside an editable element. Text typed into it reaches the actor as `input` events and is sent once; its keydowns still run through the prefix and binding checks so a bound printable key wins
3. If in copy mode: key routed to `COPY_MODE_KEY` handler (handled client-side, see [COPY-MODE.md](COPY-MODE.md))
4. If prefix key pressed: enters prefix mode, waits for next key to match a binding
5. Otherwise the keydown is classified as text or chord (see below) and `keyboardActor` sends `SEND_TMUX_COMMAND` — literal text with `send-keys -l`, a chord as a tmux key name
6. The `KeyBatcher` in the adapter batches rapid keystrokes (e.g., typing "hello") into single `send-keys` commands
7. Command reaches tmux via control mode stdin
8. tmux processes the keystroke and sends `%output` event back through control mode stdout
9. Monitor emits a state delta with the updated pane content
10. Frontend re-renders the affected pane

### Text vs. chord

Step 5 cannot be decided by "no modifiers held". Keyboards compose characters through three paths that all set flags reading like a chord:

| Path | What the keydown looks like | Example |
| --- | --- | --- |
| Dead key | the finished character on one keydown, stamped `keyCode` 229 because the OS composed it through the IME | `´` then `a` → `á` |
| macOS Option as compose key | `altKey` set, but the letter already replaced by a non-ASCII character | Option+c → `ç` |
| AltGr third level | legacy ctrl+alt flags; only the `AltGraph` modifier state separates it from a real Ctrl+Alt chord | AltGr+Q on ABNT2 → `@` |

Forwarding one of these as a tmux key name is not rejected — tmux accepts `send-keys M-ç` and delivers ESC + `ç`, an unbound meta sequence the application discards. The classifier reads a non-ASCII key under bare Alt (and any key with `AltGraph`) as text, an ASCII key under Alt as a chord, and anything under Ctrl or Cmd as a chord. IME composition bypasses keydown and sends the committed string whole on `compositionend`.

## Servers, Sessions and the 4-Step Connect Flow

A server is one tmux socket — local (`-L` / `-S` under `/tmp/tmux-$UID/`) or remote over SSH — and holds zero or more sessions. Saved entries live in `~/.config/tmuxy/servers.json` (`packages/tmuxy-core/src/servers.rs`), enriched on list with live local sockets from `packages/tmuxy-core/src/servers/discovery.rs`. Switching among them is the session switcher (`components/SessionMenu.tsx`, and `components/SessionList.tsx` on the detached overlay), both drawing `components/SessionPicker.tsx`: a filter-as-you-type box over `sessionSwitcherSpec`'s list, which scrolls inside a capped box. Reaching a new one is one flow, `tmuxy session connect` (`packages/tmuxy-cli/bin/tmuxy/session-connect`), which `tmuxy connect` with no arguments and the switcher's "Connect over SSH…" float both run. It asks for the destination, then takes 4 stages:

```
[1. ssh / localhost] ──► [2. tmux -V] ──► [3. listing sessions] ──► [4. attach]
```

Each stage prints `✓` on success or `✗` with verbatim `ssh`/`tmux` stderr on failure. The server is saved to `servers.json`, and the attach is published as `TMUXY_CONNECT_*` for the desktop app to pick up (see [TMUX-CONFIG.md](TMUX-CONFIG.md)).

---

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — the components each transport connects
- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — what the state updates flowing over these transports contain
- [TMUX.md](TMUX.md) — why mutations must ride control mode rather than a subprocess
- [SECURITY.md](SECURITY.md) — what the unauthenticated `POST /commands` endpoint exposes
- [INVARIANTS.md](INVARIANTS.md) — the sequencing promises the stream makes (`S` and `C` rows) and what tests them
