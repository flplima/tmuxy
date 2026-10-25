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
artifact of a nightly `perf measurements` run you trust and paste
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
The C1–C4 rows in the results below came from a one-off latency-injection
proxy that no longer exists; a controlled re-run needs delay injected the same
way, between the browser and a real server, on `POST /commands` and the
`GET /events` stream.

Because the transports run over TCP, real packet loss reaches the app as delay
(head-of-line retransmit), not dropped events; the loss condition in that table
modelled it as a random extra stall rather than truly dropping bytes.

## Axis C — whole-interaction latency (the CI regression gate)

`packages/tmuxy-ui/scripts/measure-interactions.mjs` drives the handful of
things a tmuxy user does constantly and times each one from the real browser
`keydown` to the first DOM change that shows the result — arming on the
keydown, resolving on the first probe change after it. Everything goes through
the real user path: the key reaches the page, the keyboard actor resolves the
tmux binding, the command crosses the transport, tmux acts, state comes back.
Nothing is short-circuited with an adapter call, so a regression anywhere in
that chain lands in the number.

Measured today: `key-echo`, `pane-nav-keyboard`, `pane-zoom-toggle`,
`pane-split`, `tab-switch`.

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

```
npm run perf:interactions -- --url http://localhost:9000 --samples 12 \
                             --label local --out tests/perf/interaction-report.json
npm run perf:compare -- --report tests/perf/interaction-report.json
```

Add `--cdp http://localhost:9222` to attach to the Chrome the dev environment
already runs instead of launching one (the devcontainer deliberately does not
install Playwright's browsers; CI is the reverse and launches). Refresh the
committed baseline for a platform with `npm run perf:compare -- --report … --update-baseline`
and commit the result. For the Linux platforms, run the "perf measurements"
workflow (`.github/workflows/nightly-perf.yml`, `interaction-baseline` job)
instead: it measures on a runner, with more samples than the gate job takes,
and opens a PR with the refreshed file. Either way a baseline change lands
through review — CI never writes one straight to `main`.

That job is on demand, not scheduled, and a PR rather than a commit, for one
reason: a baseline that refreshes itself ratchets to whatever the runner did
last, which is the opposite of a baseline. A nightly run of it wrote artifacts
nobody opened, and the file it exists to feed was never once refreshed from
one — because the review used to mean downloading an artifact and copying a
file over by hand. The PR keeps the review and removes the chore; read the
milliseconds before merging, since a runner having a bad night produces a
baseline that hides real regressions for as long as it stands.

The desktop equivalent needs the app built first, and takes the binary rather
than a URL:

```
(cd packages/tmuxy-tauri-app && npx tauri build --no-bundle)
npm run perf:interactions:tauri -- --samples 12 --label local \
                                   --out tests/perf/interaction-report-tauri.json
npm run perf:compare -- --report tests/perf/interaction-report-tauri.json
```

CI runs both nightly, in `nightly-perf.yml` ("perf measurements"), uploading
the report as an artifact; the ratio budgets fail the run there, so a
regression shows as a red nightly the next morning:

| Job | Measures | Builds |
| --- | --- | --- |
| `interaction-latency` | Axis C, web | the frontend and the release server |
| `interaction-latency-desktop` | Axis C, desktop | the release Tauri binary, under Xvfb |
| `core-bench` | Axis A bench | tmuxy-core under the bench (release) profile |

They ran per commit until the per-commit `desktop` job switched to a debug
build: the desktop measurement needs the release binary, and that build was the
longest step on every push's critical path. With no branch protection the
per-commit gates were informational anyway. `workflow_dispatch` with `gates`
checked runs all three on demand.

### Measured

Local server on an isolated socket, macOS arm64, 10 samples per interaction,
tmux 3.7. Same machine and same session shape for both columns. Treat the
ratios as the durable part and the milliseconds as machine-specific.

| Interaction | before | after | × keystroke (before → after) |
| --- | --- | --- | --- |
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

See [PERFORMANCE-BASELINE.md](PERFORMANCE-BASELINE.md) for these sections: Measured baseline; Axis D — retention over a long session; Session snapshots.

## What's still absent (by choice, for now)

- No live production telemetry / metrics endpoint — the adaptive throttle in the
  Rust monitor keeps its counters internal; latency tracking is dev-gated.
- No client-side input prediction / local echo — an explicit Non-Goal (see
  [NON-GOALS.md](NON-GOALS.md), "Local Echo / Input Prediction"). Axis B exists in part to decide, with data,
  whether a high-latency use case ever justifies revisiting that.
- **No committed baseline for the platforms CI actually runs on.**
  `tests/perf/interaction-baseline.json` holds `darwin-arm64/*` only, and
  `tests/perf/core-pipeline-baseline.json` holds `darwin-arm64` only. Both CI perf
  jobs therefore ride on their ratio gates alone and leave the absolute column
  blank. That is the designed fallback, not a failure — but it means a uniform
  slowdown that inflates every number together, keystroke echo included, is
  currently invisible on CI. Seeding a `linux-x64` interaction baseline is
  still a human act, but no longer a manual one: run the "perf measurements"
  workflow (`.github/workflows/nightly-perf.yml`) and it opens a PR with the
  measured file for you to read and merge. The review is the point — CI must
  never ratchet a baseline to whatever the runner did last — and it had never
  happened because the review used to mean downloading an artifact and copying
  a file over by hand. The core bench baseline is seeded from the report
  `rust-tests` uploads on every commit (see Axis A above).
- **No Axis B measurement in CI.** The RTT curve and the latency-injection
  proxy are a controlled experiment run by hand, not a gate — injected delay is
  the independent variable, so there is nothing for a runner to regress.
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
