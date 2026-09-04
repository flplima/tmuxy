# Performance Measurement

How tmuxy tracks speed, and how to run each measurement. There are **two
independent axes**, they cost in different places, and they need different
harnesses. Conflating them is the most common way to measure the wrong thing.

| Axis                            | What it costs                                                                 | Harness                                    | Network         |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ | --------------- |
| **A. Core + client processing** | parse → aggregate → delta → apply → render CPU, render churn, frames-to-paint | v86/wasm probes + native criterion bench   | removed         |
| **B. Transport**                | wire RTT, head-of-line stalls, reconnect/roaming                              | `latencyTracker` + latency-injection proxy | the whole point |
| **C. Whole interaction**        | everything one keypress sets off, end to end, per user action                 | `measure-interactions.mjs` in CI           | included        |

Axes A and B decompose a single round trip; axis C asks a different question —
**how much does one thing a user does actually cost**, with every layer, every
extra round trip and every subprocess the action drags along still in the
number. An interaction can regress badly (a binding grows a `run-shell`, a
window-level refresh lands on the keystroke path) without A or B moving at all,
which is exactly the gap it exists to close.

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

## Axis C — whole-interaction latency (the CI regression gate)

`packages/tmuxy-ui/scripts/measure-interactions.mjs` drives the handful of
things a tmuxy user does constantly and times each one from the real browser
`keydown` to the first DOM change that shows the result — the same
arm-on-keydown / resolve-on-mutation technique as `measure-keypaint.mjs`,
generalized past a single keystroke. Everything goes through the real user
path: the key reaches the page, the keyboard actor resolves the tmux binding,
the command crosses the transport, tmux acts, state comes back. Nothing is
short-circuited with an adapter call, so a regression anywhere in that chain
lands in the number.

Measured today: `key-echo`, `pane-nav-keyboard`, `pane-zoom-toggle`,
`pane-split`, `tab-switch`.

### The runner-noise problem, and the ratio that solves it

Absolute milliseconds on a GitHub runner are unusable as a merge gate — the
same commit can vary two-fold between runs. So each interaction is also
reported as a **ratio to the keystroke echo measured in the same run on the
same machine**. A keystroke is the cheapest complete round trip tmuxy has; a
loaded runner inflates it and every other interaction together, and the ratio
divides that out. Only a real change in how much *work* an interaction does
moves a ratio.

That gives two signals with very different standing, and
`compare-interactions.mjs` treats them differently:

| Signal | Compared against | On regression |
| --- | --- | --- |
| ratio to `key-echo` | a per-interaction budget in `compare-interactions.mjs` | **fails the job** |
| absolute p50 | `perf/interaction-baseline.json`, keyed by platform | warns in the step summary |

Budgets are ceilings with headroom, not targets. Raising one is a deliberate
edit that shows up in review; tightening one belongs in the commit that earns
it. The baseline is keyed by platform because milliseconds from a macOS laptop
say nothing about `ubuntu-latest` — a platform with no baseline yet simply
leaves the absolute column blank and rides on the ratio gate.

### Running it

```
npm run perf:interactions -- --url http://localhost:9000 --samples 12 \
                             --label local --out perf/interaction-report.json
npm run perf:compare -- --report perf/interaction-report.json
```

Add `--cdp http://localhost:9222` to attach to the Chrome the dev environment
already runs instead of launching one (the devcontainer deliberately does not
install Playwright's browsers; CI is the reverse and launches). Refresh the
committed baseline for a platform with `npm run perf:compare -- --report … --update-baseline`
and commit the result — CI never writes it, so a baseline change is always a
reviewed one.

CI runs this as the `interaction-latency` job in `lint-and-tests.yml`, uploads
the report as an artifact, and writes the table into the job summary.

### Measured

Local server on an isolated socket, macOS arm64, 10 samples per interaction,
tmux 3.7. Same machine and same session shape for both columns. Treat the
ratios as the durable part and the milliseconds as machine-specific.

| Interaction | before | after | × keystroke (before → after) |
| --- | ---: | ---: | --- |
| `key-echo` | 29.2 ms | 38.3 ms | 1× → 1× |
| `pane-nav-keyboard` | 356 ms | **10.1 ms** | 12.2× → **0.3×** |
| `pane-zoom-toggle` | 235.1 ms | **92.3 ms** | 8.1× → 2.4× |
| `pane-split` | 82.1 ms | 78.1 ms | 2.8× → 2.0× |
| `tab-switch` | 3.5 ms | 4.7 ms | 0.1× → 0.1× |

"Before" is the state this harness was written to explain: keyboard pane
navigation cost twelve keystroke round trips. What the three fixes were, and
how the number moved, is improvement area 4 below.

The sub-keystroke numbers are not magic — `tab-switch` and (now)
`pane-nav-keyboard` paint from the optimistic prediction before tmux answers.
The harness measures what the user sees, and for a predicted op that is the
prediction; the server's answer arrives later and reconciles.

## Measured baseline

First full run of both harnesses. Treat these as the current baseline to
regress against, not as fixed constants — re-run the harnesses after any change
to the parse/aggregate/delta pipeline or the transport.

### Axis A — core + client processing (`cargo bench -p tmuxy-core`)

**Bench-integrity note.** The first published numbers (3.7–3.8 ms for
`full_sync`/`delta_rename`) were an artifact: on the native feature the
status-line dirty-refresh spawns `tmux display-message` subprocesses *inside*
`to_state_update`, and the bench hit that in the timed region — measuring
process-spawn latency, not the pipeline. The bench now supplies the status
line out-of-band (`set_status_line`, exactly what the wasm host does) and
fills panes with a real screenful (empty grids made content cost look free).
Numbers below are from the fixed bench.

Devcontainer (aarch64), same machine for both columns. "Before" is the
per-cell deep-copy pipeline; "after" is the `Arc`-shared-content pipeline
(`TmuxPane.content: Arc<PaneContent>`, `ptr_eq` skip in the grid diff):

| Bench               | Before  | After       | Change | What it is                                    |
| ------------------- | ------- | ----------- | ------ | --------------------------------------------- |
| `full_sync`         | 206 µs  | 136 µs      | −34%   | first full snapshot + screenful, 2-pane 80×24 |
| `delta_rename`      | 160 µs  | **23.5 µs** | −85%   | single-field change on an already-synced grid |
| `output_burst/200`  | 413 µs  | 321 µs      | −22%   | 200-line flood parse+aggregate                |
| `output_burst/2000` | 2.52 ms | 2.37 ms     | −6%    | 2000-line flood parse+aggregate               |

**The construction pathology is fixed.** Before, a one-field delta cost ~78%
of a full sync because every update deep-copied each pane's cell grid three
times (content-cache clone, `prev_state` clone, full-grid diff walk). Grids
are now `Arc`-shared between snapshots: an unchanged pane costs a refcount
bump, and the diff skips it by pointer identity. A metadata-only delta is
**6.8× cheaper** and no longer scales with grid size. Locked in by the
`metadata_delta_shares_content_and_omits_grids` test in
`tmuxy-core/src/control_mode/state.rs`.

Remaining honest cost: when content *does* change, extraction + line diff
still walk the grid (the µs-scale `full_sync`/burst numbers above) — that is
real work the pipeline must do, and byte parsing itself remains cheap
(~40 MiB/s).

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
every millisecond of RTT lands directly on input→paint. The **~22 ms tracker
floor** (C0) is send→apply: POST round trip + server step + SSE + client
apply. (Measured against a debug server the floor was ~24.5 ms — only ~2 ms
higher — which confirms it is transport-bound, not compute-bound.)

**The tracker starts at send, not at keydown.** `markInput()` fires when the
command leaves the adapter — so any client-side delay *before* the send is
invisible to the table above. That mattered: the `KeyBatcher` used to hold
every keystroke for its full 16 ms window before sending, an extra ~16 ms of
real, user-felt latency the tracker never saw. Measured keydown→paint
(MutationObserver on the pressed letter's echo, debug server, same machine):

| keydown→paint  | always-batch (old) | leading-edge flush (new) |
| -------------- | ------------------ | ------------------------ |
| p50            | 42.5 ms            | **25.4 ms**              |
| p95            | 62.5 ms            | 38.8 ms                  |
| max            | 66.0 ms            | 40.9 ms                  |

The `KeyBatcher` now sends an isolated keystroke immediately (leading edge)
and opens its 16 ms window for what follows; a non-empty trailing flush
re-opens the window, so sustained fast input (paste, key-repeat) still
coalesces to ~one send per frame. Keydown→POST for an isolated key dropped
from ~17 ms to ~1 ms. `scripts/measure-keypaint.mjs` measures this dimension;
`scripts/measure-latency.mjs` remains the transport (send→apply) harness.

**Loss is where the transport model actually hurts (C4).** At the same 150 ms
base RTT as C2, 5% loss-as-retransmit-stall pushes p99 from 195 ms to 978 ms and
leaves an input still un-applied (`pending` 1) — TCP head-of-line blocking
turning one lost segment into a multi-hundred-ms stall of everything behind it.
This, not steady-state RTT, is the signal a QUIC/WebTransport move would flatten.

**Throughput is decoupled from output volume.** A `seq 1 50000` flood (50k
lines) produced only **~6–8 client-side state updates** total, peaking at ~35
updates/sec, with `pending` never above 2 — the client never backed up. tmuxy
renders the *current visible grid*, not the scrollback, so the server's
aggregator coalesces an arbitrarily large burst into a handful of snapshots.
The real throughput ceiling is the Axis-A cost of extracting + diffing a
changed grid (µs-scale per snapshot, see the bench table), not client render
count. (Scrollback replay is copy-mode's job, a separate client-side path —
see [COPY-MODE.md](COPY-MODE.md).)

### Where tmuxy sits vs terminal emulators (honest framing)

tmuxy is **not** a local GPU terminal emulator; it is a tmux UI that renders
server-parsed cell-grid state to the DOM over a transport. The category
difference matters when comparing:

| Class                                     | Input latency (reference)      | Output throughput            | Network         |
| ----------------------------------------- | ------------------------------ | ---------------------------- | --------------- |
| Native GPU (alacritty/kitty/wezterm)      | ~5–45 ms (Typometer/Dan Luu)   | multi-GB/s `cat`             | none (local)    |
| Browser/xterm.js (VS Code terminal)       | higher; DOM/canvas render cost | DOM/canvas-bound             | none (local)    |
| mosh                                       | ~0 perceived (local echo)      | predicted locally            | RTT hidden      |
| **tmuxy**                                  | ~25 ms keydown→paint + RTT     | volume-decoupled (see above) | the whole point |

The honest read: tmuxy's ~25 ms local keydown→paint floor is competitive with
the upper end of a local GPU terminal, and its snapshot model makes it
structurally immune to output-volume blowups. But it has **no input
prediction / local echo** (an explicit Non-Goal, see
[NON-GOALS.md](NON-GOALS.md), "Local Echo / Input Prediction"), so unlike mosh it pays the full RTT on every
keystroke — which is fine on LAN (C1) and acceptable on a typical remote VM
(C2, ~180 ms p50) but degrades on high-RTT links (C3+).

### Prioritized improvement areas (against measured bottlenecks)

Two of the original three are done — kept here with their measured outcomes so
the next reader knows what already happened:

1. ~~**Axis A — snapshot/delta construction.**~~ **Done.** Pane grids are
   `Arc`-shared across snapshots with a `ptr_eq` diff skip: metadata-only
   deltas dropped 160 µs → 23.5 µs (−85%), full sync −34%, bursts −6…−22%.
   (The original "3.8 ms construction" number also turned out to be mostly a
   bench artifact — subprocess status-line refresh in the timed region.)
2. ~~**Axis B — the input batching floor.**~~ **Done.** The `KeyBatcher` now
   leading-edge-flushes isolated keystrokes (was: always wait the 16 ms
   window): keydown→paint p50 dropped 42.5 ms → 25.4 ms (−40%), and sustained
   input still coalesces to ~one send per frame.

Still open:

3. **Transport — targeted, not blanket.** The curve shows SSE+POST is a clean
   additive-RTT transport with no HoL cost until loss. The measurable QUIC/
   WebTransport win is specifically the C4 loss tail (p99 195 → 978 ms), not
   steady-state RTT. Input prediction (a Non-Goal) is the only thing that hides
   RTT itself; the data says revisit it only for genuinely high-RTT (C3+) remote
   use, not for LAN/typical-remote.
4. ~~**Subprocesses on the keyboard path.**~~ **Done** — three separate
   causes, found by the axis-C harness and fixed together (356 ms → 10 ms for
   keyboard pane navigation).

   - **Navigation had lost its optimistic prediction.** `Ctrl+hjkl` /
     `Ctrl+arrow` are bound to the `tmuxy-nav-*` command alias, and
     `parseCommandToOp` matched that spelling — but bindings reach the client
     through `list-keys`, which reports aliases **already expanded**, so what
     a keypress actually carried was
     `run-shell "bash …/bin/tmuxy/nav <dir> …"`. That fell through to
     `RawCommand`, no prediction, and the user waited out the shell script
     *and* the round trip. The parser now recognises both spellings; tmux
     still receives the original command, so the script's group/sidebar
     semantics are untouched. This was the whole difference between 356 ms and
     10 ms — the two below are what the server no longer has to hurry through.
   - **The status-line refresh ran on every window event.**
     `executor::capture_status_line` is five `tmux display-message` calls plus
     a `sh -c` per `#(…)` in `status-right` (the shipped default is
     `#(whoami)@#H`, so six process spawns), synchronous, inside
     `to_state_update`. It was marked dirty by every window-level event *and
     by every `list-windows` response* — several times a second. It now
     refreshes only when something it renders actually changed (a fingerprint
     over the session name and each window's id/index/name/active), with a
     15 s staleness fallback matching tmux's own `status-interval` so a
     `#(…)`-driven clock still ticks. Zoom toggle: 235 ms → 92 ms.
   - **The shell helpers forked to compute their own path.** `_lib` ran
     `dirname`, `basename` and their subshells on every invocation — ~50 ms
     per call here, paid by every float, group, stack-relayout and nav — and
     `nav`'s horizontal branch made four separate `tmux` reads (window type,
     group id, edge flag) that a single `display-message` on the pane target
     answers at once. Parameter expansion and one probe: `nav right`
     187 ms → 75 ms, `nav up` 107 ms → 53 ms.

   Still open, and now the largest remaining term: **navigation shells out at
   all.** `run-shell` + bash is ~30 ms before the script does anything, and
   the Rust monitor already holds the window/pane/group state the script
   shells out to rediscover. Prediction hides that from the user, but the
   server-side move is still the honest fix.

## What's still absent (by choice, for now)

- No live production telemetry / metrics endpoint — the adaptive throttle in the
  Rust monitor keeps its counters internal; latency tracking is dev-gated.
- No client-side input prediction / local echo — an explicit Non-Goal (see
  [NON-GOALS.md](NON-GOALS.md), "Local Echo / Input Prediction"). Axis B exists in part to decide, with data,
  whether a high-latency use case ever justifies revisiting that.

## Related

- [TELEMETRY.md](TELEMETRY.md) — the trace file that generalizes `latencyTracker` into a cross-layer timeline
- [DATA-FLOW.md](DATA-FLOW.md) — the transports Axis B measures
- [NON-GOALS.md](NON-GOALS.md) — input prediction and the other latency techniques we deliberately skip
- [TESTS.md](TESTS.md) — the Storybook probes the Axis-A story measurements ride on, and where the Axis-C job sits among the suites
