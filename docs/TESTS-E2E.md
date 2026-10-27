# E2E, Latency and Desktop Tests

The browser + tmux suites, the latency gate and the Tauri suite. Part of [TESTS.md](TESTS.md).

## E2E Tests

### Suites

`npm run test:e2e` runs every `*.test.js` under `tests/` except `tests/cli/` and `tests/tauri/` (`jest.config.js`). In CI each file below is its own matrix entry.

| File | Covers |
| --- | --- |
| `tests/1-input-interaction.test.js` | Keyboard, paste, international input, mouse click/scroll/drag/SGR, mouse selection, copy mode navigate/yank, touch scroll (CDP touch events), viewport resize at 800x600 and 1920x1080 |
| `tests/2-layout-navigation.test.js` | Windows/tabs, tab overview, marked and collapsible panes, zoom, drag to tab strip, pane groups, float lifecycle and close paths, sidebar tree, pinned dock, status bar, fzf in a float |
| `tests/3-rendering-protocols.test.js` | OSC 8 hyperlinks, OSC 52 clipboard, Unicode, SGR faint, image protocols |
| `tests/4-session-connectivity.test.js` | Reload preserves state, offline/online connection overlay, multi-client, command routing, multi-session sidebar |
| `tests/5-stress-stability.test.js` | Large output (`yes \| head -500`, `seq 1 2000`), rapid operations, glitch detection |
| `tests/6-nvim-performance.test.js` | One nvim boot: rendering a 500-line file, cursor shape (DECSCUSR) through insert mode, half-page scrolling, discarding the edit |
| `tests/7-regression-bugs.test.js` | One scenario per production bug the other suites missed |
| `tests/8-tui-alternate-screen.test.js` | Heavy alt-screen TUI (`tests/fixtures/heavy-tui.sh`) compared line by line with `capture-pane`; wheel to a mouse-tracking TUI started before attach |
| `tests/11-webkit.test.js` | The same selection, copy and focus flows under Playwright WebKit — the only proxy CI has for WKWebView, where those bugs escaped. Skips loudly when WebKit is absent; `TMUXY_E2E_REQUIRE_WEBKIT=1` makes that a failure |
| `tests/12-touch*.test.js` | `hasTouch` phone contexts: portrait 390x844 (tap to focus the hidden input, swipe to open the scroll view, the tab strip, no horizontal overflow) and `-sideways` 844x390 (terminal right of the chrome, cursor in view under a keyboard) |
| `tests/13-send-permission.test.js` | `tmuxy pane send -t` into another pane — the question drawn over the target, allowed from the sending pane (keys land) or declined (nothing lands), a long multi-line send in its scrolling block, and `@tmuxy-send-ask off` / `@tmuxy-send-allow` skipping it with the unread mark left behind |
| `tests/14-widget-authorisation.test.js` | SEC-18: a widget marker printed by a shell draws nothing; `tmuxy widget tree` does, and its exit takes the authorisation with it |
| `tests/14-widget-preview.test.js` | `tmuxy open` on a markdown document (diagram and image drawn, followed as the file changes at the same scroll position, Ctrl+C back to a shell that still takes Ctrl+C, and the read refused afterwards) and on a page (framed offline with only its own folder's files, kept in place across a change, Ctrl+C from inside the frame) |
| `tests/15-session-snapshot.test.js` | Session snapshots on a server of the test's own (own socket, port and state dir) — autosave follows split, float, tab, group, sidebar and restore tags; SIGTERM + `kill-server` + restart rebuilds the shape; `forget` needs `--force` |
| `tests/snapshots/snapshot.test.js` | Read-only UI ↔ tmux comparison, no interactions |

Helpers live in `tests/helpers/`, one file per domain: `browser.js` (CDP connect or launch), `own-browser.js` (a browser context the suite owns — touch, phone width, WebKit), `test-setup.js` (`createTestContext`), `extra-server.js` / `read-only-server.js` / `public-name-proxy.js` (a second server beside the suite's own), `snapshot-server.js` (a server of the test's own that can be stopped and restarted), `server-binary.js` (the newest built `tmuxy-server`), `TmuxTestSession.js`, `tmux-side.js` (what tmux holds for a session, for failure messages), `reap.js` (shells left in the kernel by a torn-down pane), `keyboard.js`, `pane-ops.js`, `window-ops.js`, `pane-groups.js`, `copy-mode.js` / `copy-mode-ui.js`, `selection-drag.js`, `mouse-capture.js` (with the `mouse-capture.py` fixture it runs in a pane), `cell-grid.js`, `layout.js`, `glitch-detector.js`, `snapshot-compare.js`, `content-match.js`, `consistency.js`, `cli.js`, `tmux-socket.js`, `config.js`, and `trace-environment.js` (the Jest environment that stamps a trace marker per test). Import them through `tests/helpers/index.js`.

### Environment

- Tests connect to an existing Chrome via CDP on port 9222 — never install Playwright browsers locally (CI provisions its own chromium; that's the one exception)
- All E2E tests run sequentially (`maxWorkers: 1`) — they share one tmux server
- A tmuxy server must be reachable on `TMUXY_PORT` (default 9100, `tests/helpers/config.js`); the suite builds and starts one itself — on that port — if nothing answers. One port per environment, like one socket per environment: 9000 belongs to a released build and `bin/dev-server`, 9100 to this suite. A server that is already up is asked which tmux socket it drives and REFUSED unless it is this run's, because a stranger's server fails the suite as a wall of unrelated flakes rather than as a port conflict
- Missing prerequisites FAIL the run. A suite that cannot reach Chrome or the server used to skip every test and report green, which is worse than a red: it says a suite ran that never did. Set `TMUXY_E2E_ALLOW_SKIP=1` to opt into the old behaviour

### What the helpers guarantee

Three rules live in `tests/helpers/` rather than in each test, so a fix lands once instead of ninety times:

- **Text has to be on screen to count.** `getTerminalText` and `waitForTerminalText` read only the terminals the user can actually see — a pane in a background tab, a parked pane-group member and a closed sidebar all keep their content mounted, and joining all of them let a test pass on text nobody could read. `waitForTerminalText` goes further and checks the line carrying the text has a real box, inside its pane and inside the viewport. Pass `{ scope }` to narrow to one pane (`'.pane-active'`, or `[data-pane-id="%3"]`)
- **Wait for the state, don't sleep.** `waitForLayoutSettled` returns once the panes, their boxes and the focus have been the same twice in a row; every helper that changes the layout (split, nav, swap, zoom, kill, layout cycle) ends with it instead of a flat 500ms. `typeInTerminal` waits for the app to be holding the keyboard rather than sleeping before it types
- **The app says when it has caught up.** `waitForSettled` asks `window.app.settled()` (`AppProvider`): no command queued or in flight to the backend, no keystroke batched and unsent, no optimistic op awaiting tmux's verdict, and the store holding the state at the stream's last sequence number — then two painted frames. It is the question a `delay(DELAYS.SYNC)` after a click or a prefix key was guessing at, answered the moment the round trip is over, and waited for when the trip takes longer than a guess. It says nothing about a program in a pane; that is `waitForTerminalText`'s question. `waitForCondition` returns the truthy value its condition produced, so a wait that needs what it waited for (a title, a set of images) is one call rather than a loop of its own
- **A wait is patience, not a stopwatch.** `waitForShellPrompt` bounds how long the terminal may go _without changing_ and resets that on any change, so a slow runner still drawing keeps its wait. A fixed deadline is a constant that encodes how fast the machine is: at 10s it passed locally and failed on a loaded CI runner whose shell had not yet written a byte. It also requires the prompt to be the _last_ thing in a terminal — a `>` in the output of an earlier command used to count, reporting a shell ready while it was still mid-command, so the failure landed on the next step instead
- **A wait budget is relative, not absolute.** The 145 `waitForCondition` bounds in the suite are numbers someone measured on their own laptop, spanning 1000ms to 45000ms. `TMUXY_WAIT_SCALE` restates all of them at once for a machine that is not that one, so a slower or busier box is one knob rather than 145 edits (`waitBudget` in `tests/helpers/config.js`; every wait helper routes through it). Default 1, so it changes nothing where the numbers were already right. Raising it cannot turn a failing test green — a condition that will never hold still never holds — so it buys a slow machine time to be right and nothing else
- **A slow runner can be summoned.** `TMUXY_E2E_CPU_THROTTLE=<factor>` slows the page's renderer by that factor (the storybook probe's `PROBE_CPU_THROTTLE`, for the web suite), which is how to see on a laptop what a loaded CI runner sees. It throttles the browser only: a race that lives in the server or tmux round trip — the `-X cancel` that ends copy mode landing a snapshot late — is not reached by it, and has to be reasoned out and pinned by a unit test instead. The page's own errors and warnings print into the test output (`[page error]`, `[page warning]`), so a product path that should not have run says so next to the assertion it broke.
- **Teardown waits for the monitor, not a clock.** `afterEach` polls tmux until the session is gone and no client is left attached to it. That was a flat `delay(4000)` — about 6.5 minutes of pure sleep across the suite, and a coupling where one test's slow shutdown failed the next one

Start the Chrome the tests attach to with any system Chrome/Chromium:

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tmuxy-e2e-chrome --no-first-run --no-default-browser-check &
curl -s http://127.0.0.1:9222/json/version   # confirm it answers before running the suite
```

**Confirm that Chrome is up first.** Without it every test fails at `skipIfNotReady()` with the reason (server unreachable, or no CDP on 9222). It used to skip and report green in a couple of milliseconds, which looks identical to a real pass; that is now opt-in with `TMUXY_E2E_ALLOW_SKIP=1`, for running one suite without the full stack.

The suite pins `TMUX_SOCKET` to **`tmuxy-test`** and clears `$TMUX` in `tests/jest.setup.js` (the default lives in `tests/helpers/tmux-socket.js`), so it is safe to run from inside a tmux pane: it creates and kills sessions on a socket of its own, never the `tmuxy` socket a running tmuxy — quite possibly the one you are sitting in — is serving.

**The server under test has to be on that socket too.** It is the other half of every round trip: a server attached elsewhere leaves the tests reading and writing different tmux servers, and every one of them fails at "session not found" while the UI looks perfectly healthy. The suite gets this right on its own — a server it starts inherits the pinned socket, and CI sets `TMUX_SOCKET` for the whole e2e job. Only a server you started by hand can diverge, so start it to match:

```bash
TMUX_SOCKET=tmuxy-test ./target/release/tmuxy-server   # or just let the suite start its own
```

The setup step warns when it reuses a server it did not start, because a running server reports no socket and the mismatch cannot be detected — only flagged.

**Another tmux.** `TMUX_BIN` names the tmux binary for the server, the CLI and the harness (`tmuxBin()`): `TMUX_BIN=/opt/tmux-3.2a/bin/tmux npm run test:e2e -- <suite>` runs against the floor without touching the one on `PATH`.

The Tauri suite (`tests/tauri/`) pins the same socket, in its `jest.global-setup.js` and before `tauri-driver` starts, because the driver hands its environment to the app binary it launches. There the app and the assertions about it are the two halves that have to agree — unset, the app falls back to its own `tmuxy` default while the shared helpers resolve `tmuxy-test`, and the suite reports panes and windows missing from a server the app never touched.

### Session Lifecycle

- Each **test** gets a fresh tmux session: `createTestContext()`'s `beforeEach` creates a `TmuxTestSession`, and `afterEach` destroys it
- Never leave tmux sessions or windows behind — the context's `afterEach`/`afterAll` handle cleanup; don't bypass them

### Timing

- Use `waitForCondition` or `page.waitForFunction` with explicit conditions instead of `delay()`
- When you must wait, prefer polling for the expected state over sleeping a fixed duration
- Flaky waits indicate the test is not waiting for the right condition

### Visual Verification

Every E2E test that creates UI elements verifies they are visually present, not just in the DOM:

| Instead of | Also assert |
| --- | --- |
| The element handle is not null | Its `boundingBox()` exists with width and height above a meaningful floor (e.g. 50px) |
| A container's `textContent` contains the token | That same container's `getBoundingClientRect()` has visible width and height |

For terminal text, verify positions **in cells** and against tmux, not just that the text exists: `tests/helpers/cell-grid.js` converts bounding rects into cells using the published `--cell-w` (`getCellWidth`, `getCursorGeometry`, `getRunGeometry`), and tmux's `#{cursor_x}` (via `session.runCommand('display-message -p -t <session> ...')`) is the oracle for where a run must end. A wide glyph is expected to own a 1-cell box with ~2 cells of ink; the ASCII run after it must start on the cell tmux says.

### Keyboard Input Tests

When testing keyboard input to a specific pane (float, tiled, etc.):

1. Verify the input target is correct before typing (check `focusedFloatPaneId` or `activePaneId`)
2. After typing and pressing Enter, verify the **output** appears in the correct pane's visible area — not just in the DOM
3. Verify the output did NOT appear in other panes (input isolation)

### Escape Key and Modal Close

The Escape key has dual meaning: it can close a modal OR be sent to the terminal application. Tests for Escape-to-close must verify the modal actually closes (element removed from DOM), not just that the focus state changed.

### Target by Stable IDs, Not Indices

When tests need to target specific tmux windows or panes (e.g., to kill a window or send keys), always use stable IDs (`@N` for windows, `%N` for panes) rather than indices (`:N`, `.N`). Indices shift when objects are created or destroyed, causing races between the query that reads the index and the command that uses it. See [TMUX.md](TMUX.md#targeting-use-stable-ids-not-indices) for the full rationale.

### No Skipped Tests

Never commit `it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, or `xdescribe`. ESLint enforces this via `jest/no-disabled-tests` (error) for `tests/`; the Vitest files under `packages/tmuxy-ui/src` have no such rule, so review catches them there. Fix the test, fix the bug, or remove the test entirely.

## Interaction-Latency Tests

A nightly job (`interaction-latency` in `nightly-perf.yml`, with a desktop twin) times the
interactions a user performs constantly — typing, moving between panes,
splitting, zooming, switching tabs — through the same real keyboard path the
E2E suites use, and gates on how expensive each one is **relative to a single
keystroke round trip measured in the same run**. That ratio is what survives
runner load; absolute milliseconds are recorded as a trend only. It exists to
catch the class of regression the functional suites pass straight through: the
feature still works, it just costs three times what it used to.

Adding an interaction means adding one entry in
`packages/tmuxy-ui/scripts/lib/perf-harness.mjs` (how to trigger it, and the
visible thing that says it happened) and one budget in
`compare-interactions.mjs`; the web and desktop harnesses both pick it up from
there. See [PERFORMANCE.md](PERFORMANCE.md) § Axis C for the design and the
current numbers.

## Desktop (Tauri) Tests

The desktop app wraps the same React UI with native IPC instead of HTTP/SSE, so desktop tests cover the seam, not the UI again.

- **Tauri E2E** (`tests/tauri/tauri-app.test.js`): Jest → WebdriverIO → `tauri-driver` on port 4444 → WebKitWebDriver → a debug build at `target/debug/tmuxy`. The global setup builds the frontend and the binary, starts Xvfb on `:99` and the driver; each test launches a fresh app with its own session. Covers app lifecycle, IPC commands through `invoke()`, events through `listen()`, and state sync. Linux only (WebKitGTK and Xvfb).
- **Smoke tests** (`tests/smoke/`, run by `build-app.yml` after the release build and by `desktop` on PRs): `smoke-test.js` launches the app on Linux (`tauri-driver` + Xvfb) and macOS (`tauri-webdriver` against a debug build with `--features webdriver`), types a command, sees the output, and reads the app's log file (`tmuxy.log` in its state dir) to require no `FATAL` and at most two control-mode connects. `macos-sparse-path-test.js` launches the release binary under launchd's sparse `PATH` and requires a stable connection.
- Visual behavior assertions follow the same guidelines as E2E (verify visible, not just in DOM).

## Debugging

```bash
# Single scenario by name
npm run test:e2e -- --testNamePattern="Scenario 22"

# Verbose output
npm run test:e2e -- --verbose
```

**Where a run's time went.** Every `lint and tests` run ends with a `timing` job that writes a job, step and test timing table to the run's summary page, and `bin/ci/ci-timing.mjs <run-id>` prints the same for any run. A green run says nothing about what got slower; the table does — a quarantined story at the deadline, a shard twice the size of its sibling and a cache key that stopped hitting were each found this way and invisible from the tick. Look at it before adding a runner or moving a test to the nightly tier: the fix is usually one line in the table.

**What the suite costs over time.** `bin/ci/test-cost.mjs` reports two numbers per month: **minutes-to-green** — for every push to main, the minutes until main is next green, re-runs included, so a slow suite and a red stretch both count — and the commits that went to the tests themselves (✅, and the share of those that say they are about timing). The `monthly test cost` workflow comments them on the "Test cost by month" issue on the 1st, so the trend is on record. De-flaking pays off when to-green p90 and the ✅ share both fall; a falling blind-wait ceiling with flat numbers means the work went somewhere that was not the problem.

When CI's E2E or latency job fails, its last step prints the tail of the server log (`/tmp/tmuxy-server.log`). A local suite-started server writes stderr to `/tmp/tmuxy-server-stderr.log`.

**Reading a failed E2E test.** The server under test writes its action trace (docs/TRACING.md) to `TMUXY_E2E_TRACE` — in CI `/tmp/tmuxy-e2e-trace.ndjson`, locally `trace.ndjson` in the run's scratch state dir — and the suites' Jest environment (`tests/helpers/trace-environment.js`) stamps a marker at each test's start and end. When a test fails, the trace health check for that test's slice is printed after it: silent panes, reconnects, rejected commands. Every CI E2E job runs the same check on the whole run as GitHub annotations, passing or not, and a failed shard uploads the trace, the server log and the Jest output as `e2e-<suite>-attempt-<n>`. Setup helpers fail where they fail: `navigateToSession` and `verifyRoundTrip` throw with what the page showed and what tmux holds for the session (`tests/helpers/tmux-side.js`) rather than letting a later wait report a bare "no prompt". The shared server runs with `TMUXY_NO_SNAPSHOT=1` and `TMUXY_NO_RESTORE=1` and a scratch `TMUXY_STATE_DIR` (`tmuxEnv` in `tests/helpers/tmux-socket.js`, and the CI job's `env`): it neither saves sessions nor rebuilds one from a previous run, so a suite always starts on an empty tab. Session snapshots are tested on a server of the test's own (`tests/helpers/snapshot-server.js`), whose `serverLog()` is what a failed wait there prints.
