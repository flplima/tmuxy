# Action Tracing Design

The trace file's schema, its instrumentation seams and correlation. Part of [TRACING.md](TRACING.md).

## Design

### One Rust-owned file, one shared schema

The trace is a single **NDJSON** file (one JSON object per line): crash-safe
appends, streamable, greppable, and trivially convertible to a Perfetto
timeline. NDJSON is the source of truth; the timeline view is an export, not the
storage format.

A **Rust process owns the file.** All Rust-side events are written directly;
frontend events are shipped to that process and merged into the same file, so
there is exactly one writer and one file regardless of how many browser tabs are
connected.

```
  Tauri desktop                          tmuxy server + browser
  -------------                          ----------------------
  React/XState/Effect                    React/XState/Effect
        | client trace events                  | client trace events
        v  (Tauri IPC)                          v  (POST /trace, batched)
  Rust (Tauri shell) --------.           Rust (server) --------.
        |                    |                  |               |
  tracing Layer -------> trace.ndjson     tracing Layer --> trace.ndjson
   (all Rust spans)      (one file)        (all Rust spans)   (one file, on VM)
```

### The Rust side is (almost) free

Every Rust layer already emits `tracing` spans and events. A custom
`tracing-subscriber` **Layer** that serializes each span/event to one NDJSON
line captures all of it — the monitor's spans, the `#[instrument]` handlers,
every `info!`/`warn!`/`error!` — with **zero new call sites**. The work is:

1. Write the NDJSON `Layer` and add it to the subscriber in `init_logging()`.
2. **Install the subscriber on every entry path**, including the Tauri GUI path
   that currently skips it (the gap above).
3. Take timestamps at the layer, from the system clock, so the pure core
   stays pure.

The handful of hot-path events that matter for causality but aren't yet spans
(aggregator `step`, monitor flush decision, emitter dispatch) get one
`#[instrument]` or structured event each — recording the **typed variant name
and ids only**, never the command string (see [§ Safety](TRACING.md#safety--the-redaction-boundary)).

### The frontend side generalizes what exists

Three seams are already tapped; the tracer reuses them rather than adding new
ones:

- The **`send` monkey-patch** in `packages/tmuxy-ui/src/machines/AppContext.tsx`
  sees every event dispatched to the app machine and emits one trace event per
  event type.
- The **Effect chokepoint**: every adapter call runs through
  `Effect.runPromiseExit` in `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts`,
  yielding a typed `AdapterError` (`packages/tmuxy-ui/src/infra/transport/AdapterError.ts`).
  That exit is the natural place to record the outcome of every client→backend
  call.
- The **adapter round-trip hooks**: `latencyTracker.markInput()` (send) and
  `recordUpdate()` (apply) already fire in both `HttpAdapter` and `TauriAdapter`.
  The tracer emits alongside them.

A small `tracer` singleton mirrors `latencyTracker`'s structure — same runtime
gating, same `window.__*` exposure, a buffer that batches events and ships them:
`POST /trace` on the web, Tauri IPC on the desktop. Both land in the one
Rust-owned file.

### Event schema

One flat object per line. Content-free by construction.

| Field | Meaning |
| --- | --- |
| `ts_wall` | wall-clock time (ms), for human reading and cross-machine ordering |
| `ts_mono` | monotonic time (µs) from the layer's clock, for duration math within a process |
| `layer` | `xstate` \| `effect` \| `adapter` \| `http` \| `monitor` \| `aggregator` \| `emitter` \| `tmux` \| `tauri` \| `render` |
| `component` | originating module/actor (e.g. `keyboardActor`, `transport`, `SessionBroadcast`) |
| `name` | event or span name (a **typed variant**, never a command string) |
| `phase` | `event` \| `start` \| `end` (spans emit start/end; point events use `event`) |
| `dur_us` | span duration on `end`, when known |
| `action_id` | causal id minted at action origin; see [§ Correlation](#correlation) |
| `session` | tmux session name |
| `conn_id` | client connection id (distinguishes browser tabs on a shared server) |
| `seq` | SSE monotonic id and/or delta `seq`, for return-path joins |
| `pane` / `window` | tmux target ids (`%N` / `@N`) |
| `attrs` | small map of non-content metadata (counts, flags, error tag, latency) |

### Instrumentation seams

Each seam already exists in the code; the tracer emits at it.

| Layer | Seam (file) | What it records |
| --- | --- | --- |
| xstate | `send` tap, `machines/AppContext.tsx` | app-machine transition (event name only); the derived `TMUX_MODEL_UPDATE` firehose is coalesced to a periodic `phase:'count'` |
| store | dispatch, `machines/actors/tmuxStoreActor.ts` (via `parseCommandToOp`) | `TmuxOp` variant (Split, SelectPane, KillWindow, ZoomToggle, …) + target ids — the WHAT, args discarded |
| effect | `Effect.runPromiseExit`, `tmuxActor.ts` / `tmuxStoreActor.ts` | adapter/op **failures** by typed `code` (`AdapterError` / `OpError` tag) |
| adapter | `markInput` in `drivers/HttpAdapter.ts` / `drivers/TauriAdapter.ts`, `recordApplied` in `stateFeed.ts` | send (kind, `action_id`) and apply (delta `seq`) boundaries + latency |
| http | `POST /commands` header, `sse.rs` | `action_id` (`X-Action-Id`) → the exact request-leg join |
| server | `send_via_control_mode`, `sse.rs` | the mutating ingress by command **verb** (first token; args only at `full`) |
| emitter | `emit_state`, `sse.rs` | each state emit by delta `seq` + kind, joinable to the client `apply` |
| tmux | the in-band reads in `tmuxy-core/src/transport.rs` | read op name + argc |
| tauri | title-bar chrome, `infra/desktopWindow.ts` → `tmuxy-tauri-app/src/titlebar.rs` | each status-bar action (`set_titlebar_height`, `titlebar_double_click`) under a `titlebar-*` `action_id`, joined to its native outcome: the traffic-light centre `y` for a bar `height`, or the double-click `kind`/`variant` (zoom → maximized/restored, minimize, none) |
| tauri | title-bar chrome, `infra/desktopWindow.ts` → `tmuxy-tauri-app/src/titlebar.rs` | each status-bar action (`set_titlebar_height`, `titlebar_double_click`) under a `titlebar-*` `action_id`, joined to the native outcome: traffic-light centre `y` for a bar `height`, or the double-click `kind`/`variant` (zoom → maximized/restored, minimize, none) |
| marker | `tmuxy trace --mark`, `trace_view.rs` | a user-stamped "bug happened here" label |
| pane | aggregator, `control_mode/state.rs` | each pane's life, content-free: `pane appeared` (window, size, `shell`, `bytes` replayed from before it was listed), `pane first output` (`bytes`), `capture requested`, `pane captured` (non-blank `lines`), `pane resized`, `pane gone`. The session comes from the monitor's `run{session}` span |
| server | session creation, `sse.rs` | `session creation path`: `via` `courier` (through another session's control client, with its `viewers`) or `direct` |
| test | `tests/helpers/trace-environment.js` | an E2E run's markers: `<file> › <test> › start` and `› pass`/`› fail`, so one test's slice can be read with `--window` |

The durable contract from [DATA-FLOW.md](DATA-FLOW.md) maps cleanly to spans:
the **aggregator** decides _what_ (delta kind), the **monitor** decides _when_
(flush), the **emitter** decides _where_ (SSE vs Tauri). Those three are the
server-side span boundaries.

### Correlation

An **`action_id`** is minted client-side when a user action originates (a
keydown that produces a command, or a typed op dispatch) and threaded through
the **request leg**: adapter → `POST /commands` (header or body field) →
`ClientCommand` → `MonitorCommand`. Every event on that leg carries the same
`action_id`, so the outbound half of a chain joins exactly.

The **return leg is a heuristic join, not an exact one.** tmux emits `%output`
and other events asynchronously, not tagged to the command that caused them, so
a state-update cannot carry the originating `action_id`. State-updates are
correlated to actions by the existing counters — SSE monotonic `id`, delta
`seq` — plus FIFO timing, exactly the matching `latencyTracker` already does
(`packages/tmuxy-ui/src/infra/latencyTracker.ts`). The trace records the join
keys and leaves the ambiguity visible rather than pretending to a precision the
transport can't provide.
