# E2E, Latency and Desktop Tests

The browser + tmux suites, the latency gate and the Tauri suite. Part of [TESTS.md](TESTS.md).

## E2E Tests

### Suites

`npm run test:e2e` runs every `*.test.js` under `tests/` except `tests/cli/` and `tests/tauri/` (`jest.config.js`). CI runs them as the shards of `tests/e2e-suites.json`, one runner each (`e2e (<shard>)` in `lint-and-tests.yml`): an entry's `path` is a regex over the file path, and a shard is named for what it covers, never for a file's number. **A new file must match exactly one entry's regex** — `bin/ci/e2e-plan.test.mjs` asserts it over every file, so a file no shard runs fails `npm test`. Files are `tests/<name>.test.js`:

| Shard | Files | Covers |
| --- | --- | --- |
| `input` | `1-input-interaction` and its `-clipboard`, `-copy`, `-keys`, `-mouse`, `-scrollback-select` | Keyboard, paste, international input, mouse click/scroll/drag/SGR, selection, copy mode navigate/yank, OSC 52, viewport resize |
| `layout` | `2-layout-navigation` and `-float`, `-groups`, `-overview`, `-panes`, `-zoom-drag` | Windows/tabs, tab overview, marked and collapsible panes, zoom, drag to tab strip, pane groups, float lifecycle and close paths, status bar, fzf in a float |
| `layout-tree` | `2-layout-navigation-dock`, `-float-scope`, `-group-drag`, `-peek`, `-tree`, `-tree-drag`, `-tree-rows` | Sidebar tree and its drags, pinned dock, peek, float scope |
| `rendering-text` | `3-rendering-protocols-links`, `-unicode` | OSC 8 hyperlinks, Unicode widths, SGR faint |
| `rendering-images` | `3-rendering-protocols`, `-images` | Image protocols and the other OSCs |
| `session` | `4-session-connectivity`, `-multi`, `snapshots/snapshot` | Reload preserves state, offline/online overlay, multi-client, command routing, multi-session sidebar; the screen against tmux (`assertScreenMatchesTmux`) |
| `stress` | `5-stress-stability` | Large output (`yes \| head -500`, `seq 1 2000`), rapid operations, glitch detection |
| `nvim` (`tier: nightly`) | `6-nvim-performance` | One nvim boot: a 500-line file, cursor shape through insert mode, half-page scrolling |
| `regression` | `7-regression-bugs` and `-b`, `-c`, `-cli-target`, `-focus`, `-run-shell` | One scenario per production bug the other suites missed |
| `tui` | `8-pane-group-tab`, `8-tui-alternate-screen` | Heavy alt-screen TUI (`tests/fixtures/heavy-tui.sh`) against `capture-pane`; wheel to a mouse-tracking TUI; a TUI in a pane-group tab |
| `tmux-3.4` (`tmux: "3.4"`) | `snapshots/snapshot`, `8-tui-alternate-screen`, `7-regression-bugs-run-shell` | The same files on the tmux Ubuntu ships; the one rerun a file may have |
| `webkit` (`webkit: true`) | `11-webkit` | Selection, copy and focus under Playwright WebKit, CI's one proxy for WKWebView; a todo where WebKit is absent unless `TMUXY_E2E_REQUIRE_WEBKIT=1` (set on that runner) |
| `touch` | `12-touch` and `-divider`, `-dock`, `-gestures`, `-keys`, `-menu`, `-sideways`, `-zoom` | `hasTouch` phone contexts, portrait and sideways: tap, swipe to scrollback, tree, menu, divider zoom/fold, cursor in view under a keyboard |
| `permissions` | `13-send-permission`, `14-widget-authorisation`, `14-widget-preview` | `tmuxy pane send -t` asking the target pane; a widget marker from a shell draws nothing while `tmuxy widget tree` does; `tmuxy open` on a document and a page |
| `personalization-plugins` | `16-personalization`, `17-plugins`, `18-plugin-links-keys-themes` | Themes, keys and the plugin install gate and actions |
| `services` | `19-mcp`, `20-push`, `23-kindle` | The `/mcp` endpoint, push notifications, the Kindle view |
| `agents` | `21-agent-states`, `22-process-icons` | Agent state badges and process icons in the tree |
| `session-snapshot` (`tier: nightly`) | `15-session-snapshot` | Snapshots on a server of the test's own: autosave follows the shape, SIGTERM + restart rebuilds it, `forget` needs `--force` |

Helpers live in `tests/helpers/`, one file per domain, imported through `tests/helpers/index.js`. The ones that shape every suite: `e2e-context.js` (`describeE2E`: the suite's hooks and browser — the shared Chromium, a context of its own for touch or a phone, or WebKit — and `openSession`), `browser.js` (`waitForCondition`, `waitForSettled`), `config.js` (ports, paths, `serverBinary()`, `tauriBinary()`), `tmux-socket.js` (`tmuxEnv`, the environment of every child process, and `scrubbedEnv`, what neither it nor the CLI suite's `scriptEnv` inherits from the developer's shell), `ui-tmux.js` (the one comparison of the screen with tmux), `snapshot-server.js` / `config-server.js` / `extra-server.js` (servers of a test's own) and `trace-environment.js` (a trace marker per test). A test reads the app only through `window.app.view()` (`packages/tmuxy-ui/src/machines/testView.ts`); everything else it checks is on the screen or in tmux.

### Environment

- Tests connect to an existing Chrome via CDP on port 9222 — never install Playwright browsers locally (CI provisions its own chromium; that's the one exception)
- All E2E tests run sequentially (`maxWorkers: 1`) — they share one tmux server
- A tmuxy server must be reachable on `TMUXY_PORT` (default 9100, `tests/helpers/config.js`); the suite builds and starts one itself — on that port — if nothing answers. One port per environment, like one socket per environment: 9000 belongs to a released build and `bin/dev-server`, 9100 to this suite. A server that is already up is asked which tmux socket it drives and REFUSED unless it is this run's, because a stranger's server fails the suite as a wall of unrelated flakes rather than as a port conflict
- Missing prerequisites FAIL the run: `describeE2E` fails its `beforeAll` when the server or the browser is missing, with the reason. A suite that skipped instead reported green having run nothing

### What the helpers guarantee

Three rules live in `tests/helpers/` rather than in each test, so a fix lands once instead of ninety times:

- **Text has to be on screen to count.** `getTerminalText` and `waitForTerminalText` read only the terminals the user can actually see — a pane in a background tab, a parked pane-group member and a closed sidebar all keep their content mounted, and joining all of them let a test pass on text nobody could read. `waitForTerminalText` goes further and checks the line carrying the text has a real box, inside its pane and inside the viewport. Pass `{ scope }` to narrow to one pane (`'.pane-active'`, or `[data-pane-id="%3"]`)
- **Wait for the state, don't sleep.** `waitForLayoutSettled` returns once the app has caught up (`waitForSettled`) and the panes drawn, their boxes, the active pane and the keyboard's target have been the same in two looks in a row; every helper that changes the layout (split, nav, swap, zoom, kill, layout cycle) ends with it. `typeInTerminal` waits for the app to be holding the keyboard rather than sleeping before it types. Every wait helper throws when its condition never holds
- **The app says when it has caught up.** `waitForSettled` awaits `window.app.caughtUp()` (`AppProvider`): no command queued or in flight to the backend, no keystroke batched and unsent, no optimistic op awaiting tmux's verdict, a query answered on the same control-mode connection (so tmux has done everything sent before it and its notifications reached the store), then two painted frames. It is the question a `delay(DELAYS.SYNC)` after a click or a prefix key was guessing at, and the barrier before a check that something did NOT happen. It says nothing about a program in a pane; that is `waitForTerminalText`'s question. `waitForCondition` returns the truthy value its condition produced, so a wait that needs what it waited for (a title, a set of images) is one call rather than a loop of its own
- **A wait is patience, not a stopwatch.** `waitForShellPrompt` bounds how long the terminal may go _without changing_ and resets that on any change, so a slow runner still drawing keeps its wait. A fixed deadline is a constant that encodes how fast the machine is: at 10s it passed locally and failed on a loaded CI runner whose shell had not yet written a byte. It also requires the prompt to be the _last_ thing in a terminal — a `>` in the output of an earlier command used to count, reporting a shell ready while it was still mid-command, so the failure landed on the next step instead
- **A wait budget is relative, not absolute.** Every `waitForCondition` bound in the suite is a number someone measured on their own laptop. `TMUXY_WAIT_SCALE` restates all of them at once for a machine that is not that one, so a slower or busier box is one knob rather than an edit per wait (`waitBudget` in `tests/helpers/config.js`; every wait helper routes through it). Default 1, so it changes nothing where the numbers were already right. Raising it cannot turn a failing test green — a condition that will never hold still never holds — so it buys a slow machine time to be right and nothing else
- **A slow runner can be summoned.** `TMUXY_E2E_CPU_THROTTLE=<factor>` slows the page's renderer by that factor (the storybook probe's `PROBE_CPU_THROTTLE`, for the web suite), which is how to see on a laptop what a loaded CI runner sees. It throttles the browser only: a race in the server or tmux round trip is not reached by it and has to be pinned by a unit test instead. The page's own errors and warnings print into the test output (`[page error]`, `[page warning]`), so a product path that should not have run says so next to the assertion it broke.
- **Teardown waits for the monitor, not a clock.** `afterEach` polls tmux until the session is gone and no client is left attached to it, rather than a flat sleep that coupled one test's slow shutdown to the next

Start the Chrome the tests attach to with any system Chrome/Chromium:

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tmuxy-e2e-chrome --no-first-run --no-default-browser-check &
curl -s http://127.0.0.1:9222/json/version   # confirm it answers before running the suite
```

**Confirm that Chrome is up first.** Without it every suite fails in its `beforeAll`, saying why (server unreachable, or no CDP on 9222).

The suite pins `TMUX_SOCKET` to **`tmuxy-test`** and clears `$TMUX` in `tests/jest.setup.js` (the default lives in `tests/helpers/tmux-socket.js`), so it is safe to run from inside a tmux pane: it creates and kills sessions on a socket of its own, never the `tmuxy` socket a running tmuxy — quite possibly the one you are sitting in — is serving.

**The server under test has to be on that socket too.** It is the other half of every round trip: a server attached elsewhere leaves the tests reading and writing different tmux servers, and every one of them fails at "session not found" while the UI looks perfectly healthy. The suite gets this right on its own — a server it starts inherits the pinned socket, and CI sets `TMUX_SOCKET` for the whole e2e job. Only a server you started by hand can diverge, so start it to match:

```bash
TMUX_SOCKET=tmuxy-test ./target/release/tmuxy-server   # or just let the suite start its own
```

The setup step warns when it reuses a server it did not start, because a running server reports no socket and the mismatch cannot be detected — only flagged.

**Another tmux.** `TMUX_BIN` names the tmux binary for the server, the CLI and the harness (`tmuxBin()`): `TMUX_BIN=/opt/tmux-3.2a/bin/tmux npm run test:e2e -- <suite>` runs against the floor without touching the one on `PATH`.

The Tauri suite (`tests/tauri/`) pins the same socket, in its `jest.global-setup.js` and before `tauri-driver` starts, because the driver hands its environment to the app binary it launches. There the app and the assertions about it are the two halves that have to agree — unset, the app falls back to its own `tmuxy` default while the shared helpers resolve `tmuxy-test`, and the suite reports panes and windows missing from a server the app never touched.

### Session Lifecycle

- Each **test** gets a fresh tmux session: `describeE2E`'s `beforeEach` names a `TmuxTestSession` (the server creates it when `setupPage` opens it), and its `afterEach` destroys it and waits for the server to let go
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

1. Verify the input target is correct before typing (check `keyboardOwner` or `activePaneId`)
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

- **Tauri E2E** (`tests/tauri/`): Jest → WebdriverIO → `tauri-driver` on port 4444 → WebKitWebDriver → a debug build at `target/debug/tmuxy`. The global setup builds the frontend and the binary, starts Xvfb on `:99` and the driver; each test launches a fresh app with its own session. Covers lifecycle, IPC (`invoke()`, `listen()`), state sync, and ssh windows signing in to an sshd container (Docker, required in CI). Linux only.
- **Smoke tests** (`tests/smoke/`, run by `build-app.yml` after the release build and by `desktop` on PRs): `smoke-test.js` launches the app on Linux (`tauri-driver` + Xvfb) and macOS (`tauri-webdriver` against a debug build with `--features webdriver`), types a command, sees the output, and reads the app's log file (`tmuxy.log` in its state dir) to require no `FATAL` and at most two control-mode connects. `macos-sparse-path-test.js` launches the release binary under launchd's sparse `PATH` and requires a stable connection.
- Visual behavior assertions follow the same guidelines as E2E (verify visible, not just in DOM).

## Debugging

```bash
# Single scenario by name
npm run test:e2e -- --testNamePattern="Scenario 22"

# Verbose output
npm run test:e2e -- --verbose
```

When CI's E2E or latency job fails, its last step prints the tail of the server log (`/tmp/tmuxy-server.log`). A local suite-started server writes stderr to `/tmp/tmuxy-server-stderr.log`.

**Reading a failed E2E test.** The server under test writes its action trace (docs/TRACING.md) to `TMUXY_E2E_TRACE` — in CI `/tmp/tmuxy-e2e-trace.ndjson`, locally `trace.ndjson` in the run's scratch state dir — and the suites' Jest environment (`tests/helpers/trace-environment.js`) stamps a marker at each test's start and end. When a test fails, the trace health check for that test's slice is printed after it: silent panes, reconnects, rejected commands. Every CI E2E job runs the same check on the whole run as GitHub annotations, passing or not, and a failed shard uploads the trace, the server log and the Jest output as `e2e-<suite>-attempt-<n>`. Setup helpers fail where they fail: `openSession` throws with what the page showed and what tmux holds for the session (`tests/helpers/tmux-side.js`) rather than letting a later wait report a bare "no prompt". The shared server runs with `TMUXY_NO_SNAPSHOT=1` and `TMUXY_NO_RESTORE=1` and a scratch `TMUXY_STATE_DIR` (`tmuxEnv` in `tests/helpers/tmux-socket.js`, and the CI job's `env`): it neither saves sessions nor rebuilds one from a previous run, so a suite always starts on an empty tab. Session snapshots are tested on a server of the test's own (`tests/helpers/snapshot-server.js`), whose `serverLog()` is what a failed wait there prints.
