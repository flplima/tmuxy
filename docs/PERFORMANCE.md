# Performance Measurement

How tmuxy tracks speed, and how to run each measurement. There are **two
independent axes**, they cost in different places, and they need different
harnesses. Conflating them is the most common way to measure the wrong thing.

| Axis | What it costs | Harness | Network |
| --- | --- | --- | --- |
| **A. Core + client processing** | parse → aggregate → delta → apply → render CPU, render churn, frames-to-paint | v86/wasm probes + native criterion bench | removed |
| **B. Transport** | wire RTT, head-of-line stalls, reconnect/roaming | `latencyTracker` + the `?perf` HUD | the whole point |
| **C. Whole interaction** | everything one keypress sets off, end to end, per user action | `measure-interactions.mjs` in CI | included |

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

`tests/perf/compare-core-bench.mjs` reads criterion's output and judges it the same
two ways Axis C does, for the same reason:

| Signal | Compared against | On regression |
| --- | --- | --- |
| ratio between two benchmarks of the same run | a budget in `compare-core-bench.mjs` | **fails the job** |
| absolute mean | `tests/perf/core-pipeline-baseline.json`, keyed by platform | warns in the step summary |

The ratio is what makes this a gate at all. Absolute nanoseconds from a shared
runner cannot block a merge, and a platform with no baseline recorded has
nothing to compare against — but `delta_rename / full_sync` is a statement
about the _shape_ of the pipeline that holds on any machine. It is budgeted at
0.4 and measures 0.11–0.17 depending on the machine; before grids were
`Arc`-shared it was ~0.78, because a one-field delta deep-copied every pane's
cell grid and therefore scaled with grid size. If that pathology returns, this
ratio catches it without anyone having recorded a number first.

A benchmark named in a budget but missing from a run also fails, so renaming a
bench cannot silently drop its gate.

**Refreshing `tests/perf/core-pipeline-baseline.json`.** A baseline must be measured
on the platform it describes, so the file holds an entry per platform and CI
never writes it — a baseline change is always a reviewed commit, the same rule
as `tests/perf/interaction-baseline.json`. For your own machine, run `cargo bench -p
tmuxy-core --bench core_pipeline` and then `node tests/perf/compare-core-bench.mjs
--update-baseline`, which merges the run under its platform key. For the CI
platform, take `core-pipeline-report.json` from the `core-pipeline-bench-<run>`
artifact of a `nightly perf` run you trust and paste
it under `platforms["linux-x64"]`. Until someone does, a CI run records its
numbers and warns about nothing; the ratio budget gates regardless.

### v86/wasm story probes (integration, relative)

`packages/tmuxy-ui/scripts/probe-spikes.mjs` drives every `v86`-tagged
Storybook story (real tmux in an x86 emulator, real Rust core in wasm) in one
shared page. It enforces the in-story budgets (glitch/size-jump, paint-frame
immediacy, render-commit, asset-weight, throughput/ordering) and, with
`PROBE_TIMINGS_JSON=<path>` set, also emits a per-story wall-clock report.
Those durations are **relative** regression signals (shared engine,
runner-load-sensitive, emulator byte-pacing artifacts), not production
latencies — useful for trend, not for absolute claims.

See [TESTS-STORYBOOK.md](TESTS-STORYBOOK.md) for the budgets and the CI wiring.

## Axis B — transport latency

Instrumentation the running product previously lacked entirely.

`packages/tmuxy-ui/src/infra/latencyTracker.ts` records the **input → paint**
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

### Measuring a link

Drive the app over the link in question with the HUD open (or read
`window.__tmuxyLatency.getSnapshot()`) to get the input→paint distribution for
that transport — the question the v86/wasm harness structurally cannot answer.
A controlled run needs delay injected between the browser and a real server,
on `POST /commands` and the `GET /events` stream. `tests/helpers/latency-proxy.js`
is that proxy: it holds each POST and each stream chunk for half the round trip
in its direction, keeps the order within a connection, and lets the page's own
files through. `measure-interactions.mjs --proxy-rtt <ms>` runs the Axis-C
suite through it, and the nightly `interaction-latency` job does so at 150 ms.
Because the transports run over TCP, real packet loss reaches the app as delay
(head-of-line retransmit), not dropped events.

**Measure a burst, not only a key.** One key at a time says what a round trip
costs; it cannot see keys queueing behind one another, because the queue is
empty whenever the keys are further apart than the round trip. That is how
the web client came to post one command at a time, each waiting for the answer
to the one before: every isolated measurement read one round trip, while typing
at 60 ms a key over a 170 ms link left the last of 30 keys 3.6 s behind. The
`key-burst` interaction (30 keys, 60 ms apart, timed from the last keydown) is
the measurement that sees it, and `tests/4-session-connectivity-slow-link.test.js`
holds the same line per commit. The fix is invariant S7 in
[INVARIANTS.md](INVARIANTS.md): the POSTs are numbered and pipelined, and the
server runs them in number order. What remains is the browser's own limit over
HTTP/1.1, six connections to a host with one of them the stream: past about
five commands per round trip they wait in the browser. HTTP/2, which a TLS
reverse proxy gives, has no such limit.

### A pane nobody looks at

`npm run perf:hidden-bytes -- --url … [--seconds N] [--out FILE]`, against a
throwaway server only, like the interactions below,
(`packages/tmuxy-ui/scripts/measure-hidden-bytes.mjs`) measures what the event
stream (`GET /events`) carries to a browser while one pane redraws an agent's
spinner at ~2 KB/s (its terminal title animated with it, as Claude Code does): with no spinner, with the spinner in a tab the browser does
not show, and with its tab shown. The bytes are the ones Chrome received on the
stream's connection (CDP), so what the link carries. `perf:compare` reads the
report and holds what a hidden spinner adds per byte it prints to a budget
(`scripts/lib/compare-bytes.mjs`).

Measured: the stream idles at ~30 B/s and a visible spinner adds ~16 KB/s, about
8 bytes per byte it printed. A hidden one adds ~0.7 KB/s (~0.35 per byte, ~2.6 MB
an hour): its screen and title are sent at most once a second, the latest frame, and at
once when its tab is shown (`control_mode/state/hidden_panes.rs`, A15 in
[INVARIANTS.md](INVARIANTS.md)). Before that it cost as much as a visible one,
every frame in full: ~55 MB an hour per agent left spinning in a background tab.

## Axis C — whole-interaction latency (the CI regression gate)

`packages/tmuxy-ui/scripts/measure-interactions.mjs` drives the handful of
things a tmuxy user does constantly and times each one from the real browser
`keydown` to the first DOM change that shows the result — arming on the
keydown, resolving on the first probe change after it. Everything goes through
the real user path: the key reaches the page, the keyboard actor resolves the
tmux binding, the command crosses the transport, tmux acts, state comes back.
Nothing is short-circuited with an adapter call, so a regression anywhere in
that chain lands in the number.

Measured today: `key-echo`, `key-burst`, `pane-nav-keyboard`,
`pane-zoom-toggle`, `pane-split`, `tab-switch`, and `key-echo-busy`: the
keystroke again, in a tab where the focused pane shares the screen with 23
panes each redrawing a spinner at ~2 KB/s (`scripts/lib/busy-panes.mjs`; the
harness writes the frames into the panes' terminals itself, so the load is
exactly that and stops with the run). Its ratio to `key-echo` is what other
panes' output costs a keystroke.

The web harness then measures **attach** (`scripts/lib/attach.mjs`): in a tab
of its own whose pane holds 10,000 lines of history, it reloads the page and
times from navigation start `attach-paint`, the focused pane showing its text,
and `attach-interactive`, the first key echoed, typing a fresh token every 100 ms
from the moment the app exists. The tokens that never show are reported as
`lostKeys`, and `attach-scroll`, a first wheel scroll over that history to every
row in view loaded (~100 ms here since history comes newest first; ~450 ms when
the whole of it came at once). `perf:compare` fails on any lost key: a key typed
during an attach arrives late, never not at all (the app holds what is typed
before its first connection and sends it, in order, the moment it lands;
`heldCommands`). Before keys were held a fifth were lost. It also records
`entryScriptBytes`, what the page's entry script cost the link on a first load,
and `perf:compare` fails on one over 400 KB, on any machine. `--only attach`
runs that alone.

What attach costs is mostly the page itself: the server answers the event stream
in ~10 ms and the initial state in ~40 ms (it waits for the window to take the
browser's size), and sends only the visible screens. So the entry script holds
only what the terminal view needs (the preview widget, with its markdown and
diagram renderers, loads when a pane first shows one), and the server compresses
its answers and lets the browser keep the hashed `assets/` for a year
(`tmuxy-server/src/server/delivery.rs`): the entry went from 1.13 MB on the wire
on every load to ~250 KB once. Measured on a loaded dev machine, before and after
interleaved: paint ~330–470 ms → ~200–220 ms, first echo ~515–675 ms →
~375–420 ms.

**Two targets, one suite.** The same interactions are measured against the web
app and against the desktop app, because they reach the same Rust core over
different transports — `POST /commands` + SSE versus Tauri IPC — and a
transport regression on one is invisible in the other. What is measured lives
once in `packages/tmuxy-ui/scripts/lib/perf-harness.mjs`; only the driver
differs:

| Target | Harness | Driver | Report |
| --- | --- | --- | --- |
| web | `measure-interactions.mjs` | Playwright (or an existing Chrome over CDP) | `target: "web"` |
| desktop | `measure-interactions-tauri.mjs` | WebdriverIO → `tauri-driver` → WebKitWebDriver | `target: "tauri"` |

Baselines are keyed by `<platform>/<target>`, so desktop milliseconds are never
compared against web ones measured on the same machine. The ratio budgets are
shared: a keystroke round trip is the cheapest complete operation on either
transport, so "how many keystrokes does a split cost" is a fair question to ask
of both.

The desktop harness drives the **release** binary (`target/release/tmuxy`), on
its own tmux socket (`tmuxy-perf`), and adopts an already-running `tauri-driver`
rather than fighting one — so it slots into a job that has already built the app
and started a driver.

### The runner-noise problem, and the ratio that solves it

Absolute milliseconds on a GitHub runner are unusable as a merge gate — the
same commit can vary two-fold between runs. So each interaction is also
reported as a **ratio to the keystroke echo measured in the same run on the
same machine**. A keystroke is the cheapest complete round trip tmuxy has; a
loaded runner inflates it and every other interaction together, and the ratio
divides that out. Only a real change in how much _work_ an interaction does
moves a ratio.

That gives two signals with very different standing, and
`compare-interactions.mjs` treats them differently:

| Signal | Compared against | On regression |
| --- | --- | --- |
| ratio to `key-echo` | a per-interaction budget in `compare-interactions.mjs` | **fails the job** |
| absolute p50 | `tests/perf/interaction-baseline.json`, keyed by platform | warns in the step summary |

Budgets are ceilings with headroom, not targets. Raising one is a deliberate
edit that shows up in review; tightening one belongs in the commit that earns
it. The baseline is keyed by platform because milliseconds from a macOS laptop
say nothing about `ubuntu-latest` — a platform with no baseline yet simply
leaves the absolute column blank and rides on the ratio gate.

### Running it

In [PERFORMANCE-RUNNING.md](PERFORMANCE-RUNNING.md), this doc's companion: the throwaway server the harness insists on, the commands and their flags.

### Measured

The ratios are the durable part and the milliseconds machine-specific. `tab-switch` and `pane-nav-keyboard` come in under a keystroke because they paint from the optimistic prediction before tmux answers: the harness measures what the user sees, and for a predicted op that is the prediction; the server's answer arrives later and reconciles.

See [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md) for these sections: Measured baseline; Axis D — retention over a long session; Session snapshots.

## What's still absent (by choice, for now)

- No live production telemetry / metrics endpoint — the adaptive throttle in the
  Rust monitor keeps its counters internal; latency tracking is dev-gated.
- No client-side input prediction / local echo — an explicit Non-Goal (see
  [NON-GOALS.md](NON-GOALS.md), "Local Echo / Input Prediction"). Axis B exists in part to decide, with data,
  whether a high-latency use case ever justifies revisiting that.
- **No CI baseline for the core bench.** `tests/perf/interaction-baseline.json`
  holds `darwin-arm64/web`, `linux-x64/web` and `linux-x64/tauri`, so the
  interaction jobs compare absolute milliseconds too; `tests/perf/core-pipeline-baseline.json`
  holds `darwin-arm64` only, so `core-bench` rides on its ratio gate alone and
  leaves the absolute column blank. That is the designed fallback, not a
  failure — but a uniform slowdown of the bench is invisible on CI until someone
  seeds `linux-x64` from the report the nightly `core-bench` job uploads (see
  Axis A above). Refreshing an interaction baseline is a human act, but not a
  manual one: the `nightly perf` workflow's `interaction-baseline` job opens a
  PR with the measured file, and the review is the point — CI must never
  ratchet a baseline to whatever the runner did last.
- **Axis B in CI is one point of the curve.** The nightly runs the interactions
  over a 150 ms link and gates their ratios; a link that loses packets, or one
  far slower, is still a run by hand.
- **Axis D does not gate yet.** Its plateau tolerances are guesses until a
  corpus of nightly runs exists to calibrate them against, and a guessed
  threshold on a long job produces a nightly nobody trusts. The numbers are
  published every night in the run summary; turning on `--gate` in the workflow
  is the follow-up.

## Related

- [TRACING.md](TRACING.md) — the trace file that generalizes `latencyTracker` into a cross-layer timeline
- [DATA-FLOW.md](DATA-FLOW.md) — the transports Axis B measures
- [NON-GOALS.md](NON-GOALS.md) — input prediction and the other latency techniques we deliberately skip
- [TESTS.md](TESTS.md) — the Storybook probes the Axis-A story measurements ride on, and where the Axis-C job sits among the suites
