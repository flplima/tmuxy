# Telemetry & Tracing

**tmuxy does not track you.** There is no analytics, no phone-home, no data sent
to us or anyone else — ever. What this document describes is a *local debugging
trace*: an optional, off-by-default record of your **actions** (not what you type
or what your programs print) that stays in a single file on your own machine, for
you to read or delete, and that exists only to help developers diagnose hard
cross-layer bugs.

## The no-tracking model

In four plain points:

- **Off by default.** A normal install records nothing. You get a trace only if
  you turn it on.
- **On only for development, or when you opt in.** Development builds enable it to
  help build tmuxy; on a release build it happens only behind an explicit flag
  you pass yourself.
- **Never leaves your machine.** The trace is a local file. It is never uploaded,
  never sent to a server we control, never shared. tmuxy has no telemetry
  endpoint to send it to.
- **For the builders, not about the user.** Its purpose is to let a developer
  (often you, filing a bug) reconstruct what happened across the layers — not to
  measure or profile people.

The rest of this document is the design that delivers that: what a trace
captures — a debuggable, cross-layer record of **what happened** across the
frontend (React/XState/Effect), the Rust backend, and the Tauri shell, into
**one local file** loadable long after the fact — where it plugs in, the boundary
that keeps your terminal content out of it, and how to use it. All three phases
of the plan are implemented; see [§ Using it](#using-it).

## Using it

- **Turn it on (release build):** `tmuxy server --trace` (default file under the
  state dir) or `tmuxy server --trace /path/to/trace.ndjson`. Development builds
  and the desktop GUI in a dev build enable it automatically and announce the
  path at startup.
- **Turn it off:** it is off by default on release builds. `DO_NOT_TRACK=1` or
  `TMUXY_NO_TRACE=1` force it off everywhere, overriding `--trace` and dev
  builds.
- **Pick a level:** `TMUXY_TRACE_LEVEL=shape|labeled|full` chooses how much
  detail vs. sensitivity (default `shape` — see [§ Trace levels](#trace-levels)).
- **Inspect it:** `tmuxy trace` prints a summary correlating actions by
  `action_id`; `tmuxy trace --export out.json` writes a Chrome-trace/Perfetto
  timeline you open at ui.perfetto.dev; `tmuxy trace --mark "<label>"` stamps a
  "the bug happened here" marker into the running trace. All accept an explicit
  file path.
- **Where it lives:** `~/.local/state/tmuxy/trace.ndjson` (Linux) or the
  platform state dir, mode `0600`, rotated at 64 MiB with one `.1` backup.

## Goals

- **One artifact, one clock.** A single append-only file that shows a causal
  chain — keydown → XState → adapter → HTTP/IPC → Rust monitor → tmux → SSE →
  apply → render — on a shared timeline, instead of three unrelated buffers
  (browser console ring, `~/tmuxy-debug.log`, server stderr) cross-referenced by
  eye.
- **Every layer.** Frontend XState transitions, Effect outcomes, adapter round
  trips, and the Rust pipeline all emit into the same stream with the same
  shape.
- **Off by default, on only on purpose.** Nothing is recorded on a normal
  install. Development builds enable it to help build tmuxy; release builds record
  only when you pass an explicit flag (see [§ Gating](#gating)).
- **Actions, not content.** Record the *shape* of what a user did, never what
  they typed or what a program printed (see [§ Safety](#safety--the-redaction-boundary)).
- **Loadable later.** The file is greppable/`jq`-able as-is and convertible to a
  Perfetto/Chrome-trace timeline for flame-graph inspection of complex issues.

## Non-goals

- **Not a metrics/observability endpoint.** No Prometheus scrape, no live
  dashboard, no aggregation service. This is a local debugging trace, not
  production monitoring.
- **Not record/replay.** The trace records causal structure and timing, not the
  raw `%output`/`%begin` control-mode byte stream needed to replay a session.
  Replay would have to capture terminal content, which [§ Safety](#safety--the-redaction-boundary)
  forbids.
- **Not a keylogger or audit log of commands.** The existing in-app activity log
  (`LOG_APPEND` → `context.log`, `packages/tmuxy-ui/src/machines/app/appMachine.ts`)
  records command *strings* and is **out of scope** as a trace source precisely
  because it carries content.
- **Browser-only deployments are out of scope for the single file.** The demo
  and v86/wasm builds have no host filesystem and no server; they are not
  traced to a file. See [§ Deployment scope](#deployment-scope).

## Where telemetry stands today

Five disconnected mechanisms, no shared timeline, no correlation, no
persistence beyond one hand-rolled file. This is the gap this design closes.

| Layer | Mechanism | Sink | Persisted? |
| --- | --- | --- | --- |
| Rust | `tracing` + `tracing-subscriber`, `RUST_LOG` filter (`packages/tmuxy-server/src/lib.rs`) | stderr | no |
| Rust | hand-rolled `debug_log` (`packages/tmuxy-core/src/debug_log.rs`) | `~/tmuxy-debug.log` | yes (one file, unstructured) |
| Rust | one real span, the Tower `tmux_call` (`packages/tmuxy-core/src/tmux_service.rs`), plus scattered `#[instrument]` | via subscriber → stderr | no |
| Rust | in-memory SSE replay ring (100) and control-mode tail (200 lines) | memory only | no (rolls over) |
| Frontend | XState event ring (200), via a `send` monkey-patch (`packages/tmuxy-ui/src/machines/AppContext.tsx`), exposed as `window.getRecentEvents()` | memory only | no |
| Frontend | in-app activity log (500), `LOG_APPEND` → `context.log` | memory only | no (**and carries command strings**) |
| Frontend | dev-gated `latencyTracker` + `PerfHud` (`packages/tmuxy-ui/src/tmux/latencyTracker.ts`) | memory only | no |

Known gaps this surfaces:

- **The two Rust log systems don't share a sink**, and neither is structured for
  machine loading.
- **The Tauri GUI drops `tracing` entirely** — `init_logging()` is called on the
  `tmuxy server` subcommand path (`packages/tmuxy-tauri-app/src/cli.rs`) but
  **not** from the desktop GUI entry (`packages/tmuxy-tauri-app/src/gui.rs`), so
  every `tracing` event is silently discarded in the desktop app. Only
  `debug_log` survives there. Fixing this is part of Phase 1.
- **No cross-layer correlation.** A frontend event and the Rust work it caused
  live in different buffers with different clocks.

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
line captures all of it — the `tmux_call` span, the `#[instrument]` handlers,
every `info!`/`warn!`/`error!` — with **zero new call sites**. The work is:

1. Write the NDJSON `Layer` and add it to the subscriber in `init_logging()`.
2. **Install the subscriber on every entry path**, including the Tauri GUI path
   that currently skips it (the gap above).
3. Route the file write through `Ctx.FileSystem` and timestamps through
   `Ctx.Clock` (`packages/tmuxy-core/src/ctx.rs`) so the pure core stays pure
   and tests stay deterministic — the same substitution seam the rest of the
   core uses.

The handful of hot-path events that matter for causality but aren't yet spans
(aggregator `step`, monitor flush decision, emitter dispatch) get one
`#[instrument]` or structured event each — recording the **typed variant name
and ids only**, never the command string (see [§ Safety](#safety--the-redaction-boundary)).

### The frontend side generalizes what exists

Three seams are already tapped; the tracer reuses them rather than adding new
ones:

- The **`send` monkey-patch** in `packages/tmuxy-ui/src/machines/AppContext.tsx`
  already sees every event dispatched to the app machine (today it feeds the
  200-entry `window.getRecentEvents()` ring). Generalize it to emit a trace
  event per transition.
- The **Effect chokepoint**: every adapter call runs through
  `Effect.runPromiseExit` in `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts`,
  yielding a typed `AdapterError` (`packages/tmuxy-ui/src/tmux/effect/AdapterError.ts`).
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
| `component` | originating module/actor (e.g. `keyboardActor`, `tmux_call`, `SessionBroadcast`) |
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
| adapter | `markInput`/`recordUpdate`, `HttpAdapter.ts` / `adapters.ts` | send (kind, `action_id`) and apply (delta `seq`) boundaries + latency |
| http | `POST /commands` header, `sse.rs` | `action_id` (`X-Action-Id`) → the exact request-leg join |
| server | `send_via_control_mode`, `sse.rs` | the mutating ingress by command **verb** (first token; args only at `full`) |
| emitter | `emit_state`, `sse.rs` | each state emit by delta `seq` + kind, joinable to the client `apply` |
| tmux | `tmux_call` Tower span, `tmux_service.rs` | async dispatch op_name + argc (**already a span**) |
| tauri | title-bar chrome, `tmux/desktopWindow.ts` → `tmuxy-tauri-app/src/titlebar.rs` | each status-bar action (`set_titlebar_height`, `titlebar_double_click`) under a `titlebar-*` `action_id`, joined to its native outcome: the traffic-light centre `y` for a bar `height`, or the double-click `kind`/`variant` (zoom → maximized/restored, minimize, none) |
| tauri | title-bar chrome, `tmux/desktopWindow.ts` → `tmuxy-tauri-app/src/titlebar.rs` | each status-bar action (`set_titlebar_height`, `titlebar_double_click`) under a `titlebar-*` `action_id`, joined to the native outcome: traffic-light centre `y` for a bar `height`, or the double-click `kind`/`variant` (zoom → maximized/restored, minimize, none) |
| marker | `tmuxy trace --mark`, `trace_view.rs` | a user-stamped "bug happened here" label |

The durable contract from [DATA-FLOW.md](DATA-FLOW.md) maps cleanly to spans:
the **aggregator** decides *what* (delta kind), the **monitor** decides *when*
(flush), the **emitter** decides *where* (SSE vs Tauri). Those three are the
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
(`packages/tmuxy-ui/src/tmux/latencyTracker.ts`). The trace records the join
keys and leaves the ambiguity visible rather than pretending to a precision the
transport can't provide.

## Safety — the redaction boundary

The trace records **the shape of an action, never its content.** This is the
line [SECURITY.md](SECURITY.md) draws (Risk #2: keystrokes and terminal output
are the eavesdropping target; Risk #7 names an action-trace as a *wanted* future
capability — but only one that excludes content).

**Never recorded:**

- `send-keys` / `send -l` / paste payloads (the literal characters typed) and
  `-H` hex byte forms
- `%output` and `capture-pane` content — the rendered grid, scrollback, cell
  data
- OSC 52 clipboard payloads and the `clipboard` SSE event body
- `/api/file` contents

**Safe to record** (the action's shape): the typed `TmuxOp` / `MonitorCommand` /
`ClientCommand` variant name; target pane/window ids; session name; connection
id; timing and latency; SSE `id` and delta `seq`; op status transitions
(`pending` / `in-flight` / `awaiting-confirm` / rolled-back); lifecycle changes
(connect/reconnect/disconnect); error tags.

Structural enforcements, not just discipline:

1. **Allowlist at the write site, not a blacklist at the source.** The trace
   Layer serializes only an explicit set of event types and fields; anything not
   on the list is dropped. A newly added event, or a stray `attrs` field, cannot
   leak by default — it has to be deliberately opted in. The famous terminal
   leaks came from the vector nobody thought to blacklist (see
   [§ Prior art](#prior-art--the-principles-we-take-from-it)).
2. **Trace the typed variant, never the string.** Recording the `TmuxOp` /
   `MonitorCommand` variant instead of the rewritten command is content-free by
   construction, and is *also* more robust — it survives the
   `neww` → `splitw ; breakp` rewrite and the `#{pane_id}` placeholder
   substitution that mangle raw command strings ([TMUX.md](TMUX.md)).
3. **Scrub the unavoidable vectors, VS Code–style.** A few genuinely useful
   fields are inherently content-bearing — window/session names, cwd and file
   paths in ops, and error / `%error` strings (which routinely quote the
   offending command or output). These are never stored raw: names and paths are
   **hashed to a stable opaque id** (the way VS Code identifies a folder by a
   hash of its git remote rather than its name), and error strings are
   **path-scrubbed and truncated** (the way VS Code scrubs user paths out of
   stack traces) or reduced to a typed error code. And the `tmuxy::debug_log`
   target — which drains raw control-mode output to disk — is excluded outright,
   so the catch-all subscriber never inherits its content.
4. **A test that the tracer never emits a raw command string, grid cell, or
   unhashed name/path.** The redaction boundary is verified, not assumed.

And one deployment rule: the trace file must live **outside** any path served by
`/api/file` (SECURITY.md Risk #4), or the trace itself becomes a readable secret
over the network.

### Trace levels

The one real usefulness↔sensitivity tension is that the most diagnostic fields
(names, paths, command args) are also the identifying ones. Rather than one fixed
setting, `TMUXY_TRACE_LEVEL` picks where on that dial to sit — evaluated once at
enable time, applied by the same allowlist visitor and the ingest sanitizer:

| Level | Adds over the previous | Sensitivity | Shareable? |
| --- | --- | --- | --- |
| `shape` (default) | typed ops + target ids, delta `seq`, command **verb** (not args), timing, **hashed** names, typed error **codes** | none — no content | yes, attach to a bug report |
| `labeled` | window/session **names**, cwd, paths in the clear; error text | reveals project/dir names + activity | trusted only |
| `full` | full command **strings** (incl. `run-shell` args) | high | never |

The bright line holds at **every** level: pane `%output` and keystroke payloads
are never captured — they are not on any instrumented path. `full` is a
local-debug escape hatch, not a content firehose.

Name/path **hashing is salted per process** (a random `RandomState` seed), so a
hashed value can't be confirmed by hashing a guessed name and can't be correlated
across separate trace files — at the cost of ids not being stable across runs.

## Deployment scope

Where the one file can exist depends on who owns a filesystem
([DATA-FLOW.md](DATA-FLOW.md) deployment scenarios).

| Scenario | File location | Client events reach it via |
| --- | --- | --- |
| Tauri desktop (local or SSH tmux) | local disk, single client | Tauri IPC |
| `tmuxy server` on a VM + browser | on the VM, multi-client (tag by `conn_id`) | `POST /trace`, batched |
| Demo / v86-wasm | — (no host FS, no server) | **out of scope** |

## Gating

Off by default everywhere. It turns on in exactly two ways, and never silently:

- **Development builds:** enabled to help build tmuxy, and **announced loudly at
  startup** (a log line naming the trace file path) so it is never a surprise.
- **Release builds:** off unless you pass `tmuxy server --trace [path]` yourself
  (there is no verbosity flag today — the server takes
  `--port`/`--host`/`--password`/`--dev` in
  `packages/tmuxy-server/src/server.rs`; `--trace` is new). When on, the server
  advertises tracing in the `connection-info` SSE event so browsers know to ship
  their events; the Tauri app reads the same flag/env locally.

Off-switches people already expect, honored explicitly:

- **`DO_NOT_TRACK=1`** (the cross-tool convention) and **`TMUXY_NO_TRACE=1`**
  force tracing off, overriding everything else — including a development build.
- The opt-out is documented here and at the flag, never buried in code.

The gate is **enforced server-side and fails closed**: the `POST /trace` ingest
endpoint rejects unless `--trace` is on, regardless of what any client believes,
so a stale client-side flag can't reopen it. **Client hot-path cost when off is a
single boolean early-return**, the same pattern `latencyTracker` uses so
production pays nothing.

## Inspection

- **Immediately:** the file is NDJSON — `grep` for a `session`/`action_id`, or
  `jq` to filter by `layer`/`name`/time window.
- **Timeline:** a `tmuxy trace` viewer subcommand loads the file, joins by
  `action_id`, and exports Chrome-trace/Perfetto JSON so it drops straight into
  `ui.perfetto.dev` for a flame-graph timeline across all layers — the view that
  makes a complex cross-layer stall legible at a glance.

## Phased plan

All three phases are implemented.

1. **Rust NDJSON `tracing` Layer** — *shipped.* `tmuxy_core::trace` defines the
   `TraceLayer` (allowlist + hash/scrub visitor) and a lossy background writer
   (mode `0600`, 64 MiB rotation). Registered by `tmuxy_server::init_logging`,
   which is now also installed on the **Tauri GUI path** (closing the
   subscriber drop). Gating and the `--trace` flag live in `trace::init` /
   `ServerArgs`. The whole Rust pipeline lands in the file with no new call
   sites — existing spans (`tmux_call`, monitor `connect`/`run`) and events flow
   in for free.
2. **Client tracer** — *shipped.* `tmuxy-ui/src/tmux/tracer.ts` mirrors
   `latencyTracker`'s gating, fed from the XState `send` tap
   (`AppContext.tsx`) and the adapter send/apply hooks, batch-shipping to
   `POST /trace` (web) or the `record_trace` Tauri command. The server advertises
   `trace_enabled` in `connection-info`, the ingest endpoint **fails closed** and
   re-sanitizes every field, and `tracer.test.ts` asserts no raw command string
   escapes.
3. **Correlation + timeline** — *shipped.* The client mints an `action_id` per
   command and threads it via the `X-Action-Id` header through `POST /commands`;
   the server records it (exact request-leg join). Return-leg correlation stays
   heuristic on `seq`/timing. `tmuxy trace` (the `trace_view` module) prints a
   per-action summary and `--export`s Chrome-trace/Perfetto JSON.

## Prior art & the principles we take from it

tmuxy's users are tmux and CLI power users — the population most hostile to
telemetry, and the one that assumes the worst. The design above is deliberately
shaped by how other terminals and dev tools have handled this, and especially by
their failures.

The load-bearing distinction: people call two different things "telemetry."
**Phone-home** sends data off your machine to a vendor (VS Code, Homebrew,
JetBrains, Warp's cloud features). **Local diagnostics** stay on the box (crash
dumps — and tmuxy's trace). tmuxy does *only* the second. That is the whole
reason the no-tracking model at the top of this document can be true.

What we take from each:

- **Content leaks come through the vector nobody guarded (iTerm2).** iTerm2's
  worst privacy failure wasn't telemetry at all — a URL-preview feature made a
  DNS request for whatever you *hovered*, leaking passwords and keys in
  cleartext, on by default, for months. The lesson is the allowlist-and-scrub
  boundary in [§ Safety](#safety--the-redaction-boundary): the leak always
  arrives through the innocuous path (an error string, a debug log), so guard at
  the write site, not the source.
- **Scrub and hash the unavoidable (VS Code).** VS Code identifies a folder by a
  hash of its git remote rather than its name, and scrubs user paths out of stack
  traces. tmuxy applies the same discipline to names, paths, and error strings.
- **Opt-out-by-default is a trust bomb (Homebrew).** Homebrew silently enabled
  opt-out analytics and met a developer revolt; it now shows a notice before the
  first collection and honors `HOMEBREW_NO_ANALYTICS`. Our answer is stronger:
  off by default, and — because nothing is ever sent — the trace stays local
  without needing any of that consent machinery.
- **The "it's just a preview" default, done right (JetBrains).** JetBrains ships
  data-sharing off in releases but on in EAP/preview builds — acceptable *only*
  because it is anonymized, consented, and withdrawable. tmuxy is a pre-release
  project and takes the same posture for development builds: on to help build it,
  but announced, trivially disabled, and never sent anywhere.
- **Local-only, never-send-content is a feature, not an omission (Warp,
  Ghostty).** Warp had to retreat to "no console data leaves your machine unless
  you opt into sync"; Ghostty markets "no telemetry" outright. tmuxy states the
  same as a principle: a single local file you own, can read, and can delete.
- **Document the off-switch even when collection is tiny (Windows Terminal).**
  Its community demanded a documented opt-out regardless of how little was
  collected. Ours lives in [§ Gating](#gating), not buried in code.

The one bright line every one of these cases draws: **never add a remote
reporting endpoint without an explicit, up-front opt-in.** That single choice is
the difference between the tools users trust and the ones that got burned. If
tmuxy ever wants aggregate insight, it must be a separate, opt-in,
clearly-consented feature — the local trace described here stays local.

## Related

- [PERFORMANCE.md](PERFORMANCE.md) — the two measurement axes; `latencyTracker`
  is the model this generalizes and the Axis-B round-trip source.
- [DATA-FLOW.md](DATA-FLOW.md) — the full user-action path, the seams, and the
  deployment scenarios that decide where the file lives.
- [ARCHITECTURE.md](ARCHITECTURE.md) — `Ctx`, the `StateEmitter` trait, and the
  Tower stack (the existing `TraceLayer` precedent).
- [STATE-MANAGEMENT.md](STATE-MANAGEMENT.md) — the XState actors and typed
  `TmuxOp` vocabulary that make content-free action tracing possible.
- [SECURITY.md](SECURITY.md) — the threat model that defines the redaction
  boundary.
