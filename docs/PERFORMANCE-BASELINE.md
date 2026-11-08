# Performance: Measured Baseline and Retention

The numbers measured so far, long-session retention, and snapshot costs. Part of [PERFORMANCE.md](PERFORMANCE.md).

## Measured baseline

First full run of both harnesses. Treat these as the current baseline to
regress against, not as fixed constants — re-run the harnesses after any change
to the parse/aggregate/delta pipeline or the transport.

### Axis A — core + client processing (`cargo bench -p tmuxy-core`)

The bench fills panes with a real screenful (empty grids made content cost
look free).

Devcontainer (aarch64), same machine for both columns. "Before" is the
per-cell deep-copy pipeline; "after" is the `Arc`-shared-content pipeline
(`TmuxPane.content: Arc<PaneContent>`, `ptr_eq` skip in the grid diff):

| Bench | Before | After | Change | What it is |
| --- | --- | --- | --- | --- |
| `full_sync` | 206 µs | 136 µs | −34% | first full snapshot + screenful, 2-pane 80×24 |
| `delta_rename` | 160 µs | **23.5 µs** | −85% | single-field change on an already-synced grid |
| `output_burst/200` | 413 µs | 321 µs | −22% | 200-line flood parse+aggregate |
| `output_burst/2000` | 2.52 ms | 2.37 ms | −6% | 2000-line flood parse+aggregate |

**The construction pathology is fixed.** Before, a one-field delta cost ~78%
of a full sync because every update deep-copied each pane's cell grid three
times (content-cache clone, `prev_state` clone, full-grid diff walk). Grids
are now `Arc`-shared between snapshots: an unchanged pane costs a refcount
bump, and the diff skips it by pointer identity. A metadata-only delta is
**6.8× cheaper** and no longer scales with grid size. Locked in by the
`metadata_delta_shares_content_and_omits_grids` test in
`tmuxy-core/src/control_mode/state/tests_sidebar_and_delta.rs`.

Remaining honest cost: when content _does_ change, extraction + line diff
still walk the grid (the µs-scale `full_sync`/burst numbers above) — that is
real work the pipeline must do, and byte parsing itself remains cheap
(~40 MiB/s).

### Axis B — transport (input → paint)

The transport curve was measured once with a latency-injection proxy that no longer exists, so no table stands here; what it showed is kept as the framing below and in [PERFORMANCE.md](PERFORMANCE.md) § Axis B. The `key-echo` interaction of the Axis-C suite measures keydown→paint on every nightly, on both targets; the tracker and HUD remain the send→apply instrumentation.

### Where tmuxy sits vs terminal emulators (honest framing)

tmuxy is **not** a local GPU terminal emulator; it is a tmux UI that renders
server-parsed cell-grid state to the DOM over a transport. The category
difference matters when comparing:

| Class | Input latency (reference) | Output throughput | Network |
| --- | --- | --- | --- |
| Native GPU (alacritty/kitty/wezterm) | ~5–45 ms (Typometer/Dan Luu) | multi-GB/s `cat` | none (local) |
| Browser/xterm.js (VS Code terminal) | higher; DOM/canvas render cost | DOM/canvas-bound | none (local) |
| mosh | ~0 perceived (local echo) | predicted locally | RTT hidden |
| **tmuxy** | ~25 ms keydown→paint + RTT | volume-decoupled (see above) | the whole point |

The honest read: tmuxy's ~25 ms local keydown→paint floor is competitive with
the upper end of a local GPU terminal, and its snapshot model makes it
structurally immune to output-volume blowups — a `seq 1 50000` flood arrives as
a handful of snapshots, since the server renders the current grid, not the
scrollback. But it has **no input prediction / local echo** (an explicit
Non-Goal, see [NON-GOALS.md](NON-GOALS.md), "Local Echo / Input Prediction"),
so unlike mosh it pays the full RTT on every keystroke — fine on a LAN,
acceptable on a typical remote VM, degrading on high-RTT links.

### Open improvement areas (against measured bottlenecks)

1. **Transport — targeted, not blanket.** SSE+POST is an additive-RTT
   transport with no head-of-line cost until loss, so the measurable QUIC/
   WebTransport win is the loss tail, not steady-state RTT. Input prediction (a
   Non-Goal) is the only thing that hides RTT itself.
2. **Navigation shells out at all.** `Ctrl+hjkl` runs the `nav` helper through
   `run-shell` + bash, ~30 ms before the script does anything, while the Rust
   monitor already holds the window/pane/group state the script rediscovers.
   The client predicts the move, so the user does not wait for it, but moving
   navigation into the server is the honest fix.

## Axis D — retention over a long session

Every axis above measures one operation against a budget. None of them can see
a leak: a retained reference keeps each individual interaction just as fast
while the heap, the DOM and the server's memory climb underneath it, and no
suite runs long enough for the climb to matter. Axis D is the question nothing
else asks — **does a long session degrade?**

| Axis D | |
| --- | --- |
| Harness | `packages/tmuxy-ui/scripts/measure-soak.mjs` (`npm run perf:soak`) |
| Load | Tens of MB of output through one pane, then hundreds of split/close cycles |
| Measures | JS heap, DOM nodes, JS event listeners (CDP `Performance.getMetrics`), server RSS |
| Verdict | A **plateau**, not a ceiling: each measure's second-half mean against its first-half mean, counted as growth only while it is still climbing at the end |
| Where | `soak` job in `.github/workflows/nightly-perf.yml` — nightly, table in the run summary |
| Gating | Not yet. `--gate` turns it on once the nightly numbers have a known shape |

Three things about it are deliberate and worth not undoing:

**It asserts a plateau rather than a number.** Absolute heap and RSS depend on
the machine, the Chrome build and what else the runner is doing, so a ceiling in
megabytes is either meaningless or permanently red. Growth between the halves of
one run divides all of that out, and it is also the only form that distinguishes
a leak from warm-up — which a single before/after reading cannot. Warm-up can
still lift the second half over the first (the output phase fills the pane with
rows for its first few windows), so a measure past its tolerance also has to be
climbing between the start and the end of the second half: a leak is, a filled
pane is flat by then.

**Load comes from the CLI, not the keyboard.** Axis C types, because the
keystroke path is its subject. Axis D's subject is what the app retains while
rendering someone else's output, so it drives load through `tmuxy pane send`.
That is also a practical necessity: typing a long command line into a pane drops
characters often enough that the load generator sometimes runs a different
command than the one it was given.

**It needs a tmux socket of its own.** It types into the active pane and splits
panes in whatever session the server it is pointed at is serving. A server
started with no `TMUX_SOCKET` serves the default `tmuxy` socket — on a dev
machine, the session someone is working in.

It is the one perf job that is scheduled, because its product is a trend rather
than a number: a soak run answers a yes/no question about that run — did
everything plateau — and the answer is only interesting as a sequence. One
night proves nothing; thirty nights show a slope. For the same reason it prints
its verdict table into the run's step summary, where it is readable from the
run page: an artifact is only read by someone who already suspects something.
CI runs it with a smaller load than the harness defaults — a shared runner is
slower at both halves, and the plateau comparison needs its windows to be clean
more than it needs them to be large.

## Session snapshots

A snapshot (`tmuxy_core::session_snapshot`) is written on every change to a
session's SHAPE, debounced one second, and once more on shutdown. Measured on an
M-series mac, a session of three windows (a two-pane split, a float, a tab):

| Session snapshots | |
| --- | --- |
| Snapshot file | ~1.2 KB (JSON, pretty-printed) |
| Autosave cost | two `list-*` queries through control mode plus one `ps` per pane, off the async runtime; nothing when the serialized form is unchanged |
| `tmuxy session save` (subprocess path) | 0.63 s wall, 0.05 s CPU — the wall is tmux round-trips, one per query and per `ps` |
| Writes over a build-up of three windows | 5 files (one per settled change), never one per keystroke: output is not a shape change (`is_structural`) |

Screen contents are not captured unless `--scrollback N` asks; a capture is one
more control-mode round-trip per pane and competes with the stream Axis C is
measured on, which is why it is opt-in.
