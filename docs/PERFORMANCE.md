# Performance Measurement

How tmuxy tracks speed, and how to run each measurement. There are **two
independent axes**, they cost in different places, and they need different
harnesses. Conflating them is the most common way to measure the wrong thing.

| Axis                            | What it costs                                                                 | Harness                                    | Network         |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | --------------- |
| **A. Core + client processing** | parse → aggregate → delta → apply → render CPU, render churn, frames-to-paint | v86/wasm probes + native criterion bench   | removed         |
| **B. Transport**                | wire RTT, head-of-line stalls, reconnect/roaming                              | `latencyTracker` + latency-injection proxy | the whole point |

The v86/wasm path measures Axis A precisely _because_ it removes the network as
a variable — so it is a clean "how fast is our code with zero transport cost"
baseline. It structurally cannot see Axis B (there is no socket in that path).
A transport change (SSE+POST → QUIC/WebTransport, or local → remote-VM) moves
Axis B only. Measure both, and the difference is the transport's contribution.

## Axis A — core + client processing

### Native benchmark (deterministic, CI-friendly)

`packages/tmuxy-core/benches/core_pipeline.rs` (criterion). Runs the **exact**
`Parser` + `StateAggregator` + `to_state_update` code that the browser runs via
`tmuxy-wasm` — one source of truth, no VT reimplementation — so native numbers
track the wasm hot path. Three groups: `full_sync` (first snapshot),
`delta_rename` (single-field delta), `output_burst` (`seq`-style flood, reported
as bytes/sec).

Run: `cargo bench -p tmuxy-core`. These are absolute, reproducible numbers —
the right place to catch a regression in the parse/aggregate/delta pipeline.

### v86/wasm story probes (integration, relative)

`packages/tmuxy-ui/scripts/probe-spikes.mjs` drives every `v86`-tagged
Storybook story (real tmux in an x86 emulator, real Rust core in wasm) in one
shared page. It enforces the in-story budgets (glitch/size-jump, paint-frame
immediacy, render-commit, asset-weight, throughput/ordering) and, with
`PROBE_TIMINGS_JSON=<path>` set, also emits a per-story wall-clock report.
Those durations are **relative** regression signals (shared engine,
runner-load-sensitive, emulator byte-pacing artifacts), not production
latencies — useful for trend, not for absolute claims.

See [TESTS.md](TESTS.md) § Storybook Tests for the budgets and the CI wiring.

## Axis B — transport latency

Instrumentation the running product previously lacked entirely.

`packages/tmuxy-ui/src/tmux/latencyTracker.ts` records the **input → paint**
round trip: when a keystroke/command leaves the client (`markInput`) and when
the resulting state update is applied (`recordUpdate`). It reports a latency
distribution (p50/p95/p99/max), the count of outstanding un-applied inputs
(`pending`), the applied-update rate, and the worst recent inter-update gap
(the stall signal). Inputs are matched to applies FIFO, so a burst of inputs
with few applies — a head-of-line stall — shows up as rising `pending` and
inflating latency, which is exactly what a roaming/QUIC transport would flatten.

It is **dev-gated**: disabled by default, so the two hooks in `HttpAdapter` and
`TauriAdapter` are a boolean check and an early return in production. Enable via
`?perf` in the URL, `localStorage.tmuxyPerf = '1'`, `window.__tmuxyPerf = true`
before connect, or `latencyTracker.setEnabled(true)`. When enabled at load, the
`PerfHud` overlay (`packages/tmuxy-ui/src/components/PerfHud.tsx`) shows the live
numbers; its store updates are coalesced to one animation frame so it can't
distort what it measures.

### Controlled comparison — the latency-injection proxy

`packages/tmuxy-ui/scripts/latency-proxy.mjs` sits between the browser and a
real `tmuxy server`, injecting configurable one-way delay + jitter (and optional
loss-as-retransmit-stall) on `POST /commands` and the `GET /events` SSE stream,
while proxying assets transparently. Drive the app through it with the HUD open
(or read `window.__tmuxyLatency.getSnapshot()`) to get the input→paint
distribution under a **known synthetic RTT** — the controlled experiment for
"how much would a faster/roaming transport actually buy us" that the v86/wasm
harness cannot run.

Because the transports run over TCP, real packet loss reaches the app as delay
(head-of-line retransmit), not dropped events; `--loss` models that as a random
extra stall rather than truly dropping bytes.

## Measured baseline

First full run of both harnesses. Treat these as the current baseline to
regress against, not as fixed constants — re-run the harnesses after any change
to the parse/aggregate/delta pipeline or the transport.

### Axis A — core + client processing (release `cargo bench -p tmuxy-core`)

| Bench               | Time    | Throughput   | What it is                                    |
| ------------------- | ------- | ------------ | --------------------------------------------- |
| `full_sync`         | 3.68 ms | —            | first full snapshot, 2-pane 80×24             |
| `delta_rename`      | 3.82 ms | —            | single-field change on an already-synced grid |
| `output_burst/200`  | 288 µs  | 32.7 MiB/s   | 200-line flood parse+aggregate                |
| `output_burst/2000` | 2.22 ms | 43.4 MiB/s   | 2000-line flood parse+aggregate               |

**Key finding — construction dominates, not parsing.** A one-field delta
(`delta_rename`, 3.82 ms) costs essentially the same as a whole-snapshot
`full_sync` (3.68 ms), while raw byte parsing is cheap (~43 MiB/s). The cost is
paid in *building and diffing the snapshot* — cell-grid extraction, the
full-grid diff walk, and serde shaping in `to_state_update` — roughly
independent of how much actually changed. That is the #1 Axis-A target: a
single-field change should not pay for a full snapshot.

### Axis B — transport (input → paint)

Release `tmuxy-server` on loopback, 26 keystrokes per condition spaced 400 ms
apart (clean per-key round trips, no batching), driven headless through the
real `POST /commands` + `GET /events` path. RTT injected with the latency proxy.
All latencies in ms.

| Condition                 | Injected 1-way / RTT | p50   | p95   | p99   | max    | pending | added vs C0 |
| ------------------------- | -------------------- | ----- | ----- | ----- | ------ | ------- | ----------- |
| C0 direct                 | 0 / 0                | 22.3  | 42.3  | 44.4  | 67.4   | 0       | —           |
| C1 LAN                    | 30 / ~60             | 86.7  | 99.0  | 100.0 | 243.2  | 0       | +64         |
| C2 typical remote VM      | 75 / ~150            | 173.4 | 194.5 | 194.6 | 215.7  | 0       | +151        |
| C3 far / bad mobile       | 150 / ~300           | 325.8 | 355.8 | 356.4 | 359.4  | 0       | +304        |
| C4 150 ms RTT + 5% loss   | 75 / ~150 + loss     | 589.2 | 710.2 | 978.1 | 1034.5 | 1       | tail blows up |

**Transport is a clean additive term.** The added latency over the C0 floor
tracks the injected RTT almost exactly (+64, +151, +304) — SSE+POST introduces
no head-of-line amplification on a clean link, and there is no local echo, so
every millisecond of RTT lands directly on input→paint. The **~22 ms local
floor** (C0) is dominated by the rAF batch window (≤16 ms) + the loopback round
trip; the server's aggregate step is a small remainder. (Measured against a
debug server the floor was ~24.5 ms — only ~2 ms higher — which confirms the
floor is frame/transport-bound, not compute-bound.)

**Loss is where the transport model actually hurts (C4).** At the same 150 ms
base RTT as C2, 5% loss-as-retransmit-stall pushes p99 from 195 ms to 978 ms and
leaves an input still un-applied (`pending` 1) — TCP head-of-line blocking
turning one lost segment into a multi-hundred-ms stall of everything behind it.
This, not steady-state RTT, is the signal a QUIC/WebTransport move would flatten.

**Throughput is decoupled from output volume.** A `seq 1 50000` flood (50k
lines) produced only **~6–8 client-side state updates** total, peaking at ~35
updates/sec, with `pending` never above 2 — the client never backed up. tmuxy
renders the *current visible grid*, not the scrollback, so the server's
aggregator coalesces an arbitrarily large burst into a handful of snapshots. The
real throughput ceiling is the Axis-A snapshot cost (~3.7 ms each → ~270
snapshots/sec), not client render count. (Scrollback replay is copy-mode's job,
a separate client-side path — see [COPY-MODE.md](COPY-MODE.md).)

### Where tmuxy sits vs terminal emulators (honest framing)

tmuxy is **not** a local GPU terminal emulator; it is a tmux UI that renders
server-parsed cell-grid state to the DOM over a transport. The category
difference matters when comparing:

| Class                                     | Input latency (reference)      | Output throughput            | Network         |
| ----------------------------------------- | ------------------------------ | ---------------------------- | --------------- |
| Native GPU (alacritty/kitty/wezterm)      | ~5–45 ms (Typometer/Dan Luu)   | multi-GB/s `cat`             | none (local)    |
| Browser/xterm.js (VS Code terminal)       | higher; DOM/canvas render cost | DOM/canvas-bound             | none (local)    |
| mosh                                       | ~0 perceived (local echo)      | predicted locally            | RTT hidden      |
| **tmuxy**                                  | ~22 ms local floor + full RTT  | volume-decoupled (see above) | the whole point |

The honest read: tmuxy's ~22 ms local floor is competitive with the upper end
of a local GPU terminal, and its snapshot model makes it structurally immune to
output-volume blowups. But it has **no input prediction / local echo** (an
explicit Non-Goal, see [NON-GOALS.md](NON-GOALS.md) §5), so unlike mosh it pays
the full RTT on every keystroke — which is fine on LAN (C1) and acceptable on a
typical remote VM (C2, ~180 ms p50) but degrades on high-RTT links (C3+).

### Prioritized improvement areas (against measured bottlenecks)

1. **Axis A — snapshot/delta construction (highest leverage).** The
   `full_sync ≈ delta_rename` result says a one-field change pays for a whole
   snapshot. Profile `to_state_update` and the grid diff with samply/flamegraph;
   likely wins are per-cell allocation in grid extraction, the full-grid diff
   walk, and serde shaping. Dirty-region / incremental diffing could cut delta
   cost by an order of magnitude and, because Axis A is the throughput ceiling,
   raise the burst ceiling too.
2. **Axis B — the rAF batching floor.** Up to 16 ms of the ~22 ms local floor is
   the animation-frame batch. Consider immediate-flush for an isolated keystroke
   and batching only under sustained high-frequency output; this trims the floor
   toward ~10 ms without hurting burst behavior.
3. **Transport — targeted, not blanket.** The curve shows SSE+POST is a clean
   additive-RTT transport with no HoL cost until loss. The measurable QUIC/
   WebTransport win is specifically the C4 loss tail (p99 195 → 978 ms), not
   steady-state RTT. Input prediction (Non-Goal §5) is the only thing that hides
   RTT itself; the data says revisit it only for genuinely high-RTT (C3+) remote
   use, not for LAN/typical-remote.

## What's still absent (by choice, for now)

- No live production telemetry / metrics endpoint — the adaptive throttle in the
  Rust monitor keeps its counters internal; latency tracking is dev-gated.
- No client-side input prediction / local echo — an explicit Non-Goal (see
  [NON-GOALS.md](NON-GOALS.md) §5). Axis B exists in part to decide, with data,
  whether a high-latency use case ever justifies revisiting that.
