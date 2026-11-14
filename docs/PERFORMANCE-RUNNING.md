# Running the interaction harness

A section of [PERFORMANCE.md](PERFORMANCE.md) (Axis C, whole-interaction latency), which says what each measure is and why.

**Only against a throwaway server.** The harness splits panes, types, opens
tabs and closes the ones it made; pointed at the server you work in, it would
do that to your session. So `--url` has no default, and the run refuses any
server whose tmux socket is not named for one (`tmuxy-perf`, or
`tmuxy-perf-<anything>`; the E2E suite's `tmuxy-test` is let through too)
before it touches anything (`scripts/lib/throwaway.mjs`). Start one on its own
`tmuxy-perf…` socket, port and `TMUX_TMPDIR`, with the environment the E2E
suites use (`tests/helpers/server-env.js`); CI's perf jobs set
`TMUX_SOCKET: tmuxy-perf`.

```
npm run perf:interactions -- --url http://localhost:9000 --samples 12 \
                             --label local --out tests/perf/interaction-report.json
npm run perf:compare -- --report tests/perf/interaction-report.json
```

Add `--cdp http://localhost:9222` to attach to the Chrome the dev environment
already runs instead of launching one (the devcontainer deliberately does not
install Playwright's browsers; CI is the reverse and launches). Refresh the
committed baseline for a platform with `npm run perf:compare -- --report … --update-baseline`
and commit the result. For the Linux platforms, run the `nightly perf`
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

CI runs both nightly, in `nightly-perf.yml` (`nightly perf`), uploading
the report as an artifact; the ratio budgets fail the run there, so a
regression shows as a red nightly the next morning:

| Job | Measures | Builds |
| --- | --- | --- |
| `interaction-latency` | Axis C, web | the frontend and the release server |
| `interaction-latency-desktop` | Axis C, desktop | the release Tauri binary, under Xvfb |
| `core-bench` | Axis A bench | tmuxy-core under the bench (release) profile |

`workflow_dispatch` with `gates` checked runs all three on demand.
