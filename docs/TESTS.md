# Testing

How tmuxy is tested today, where a new test belongs, and the rules every test follows. The first half is the map (layers, CI, gaps); the second half is the guidelines per layer.

## The Test Layers

```
                 cost / realism
                       ^
                       |   Desktop smoke (built app, Linux + macOS)   build-app.yml, tags + daily
                       |   Tauri E2E (WebDriver -> WebKitGTK app)     desktop
                       |   Web E2E + snapshots (Chromium -> server    e2e matrix (10 runners)
                       |     -> tmux 3.7a)                            interaction-latency (perf gate)
                       |   Storybook v86 probe (real tmux in an       storybook-v86-probe
                       |     x86 emulator, in the browser)
                       |   Storybook probe (DemoAdapter, Chromium)    storybook-probe
                       |   CLI suite (mocked tmux)                    cli-tests
                       |   Vitest (jsdom)  |  cargo test              unit-tests | rust-tests
                       |   ESLint, tsc, Prettier, rustfmt, clippy     lint (+ pre-commit hook)
                       +-------------------------------------------------------------------->
```

| Layer                   | Tool                                            | Location                                                                                                                       | What it is for                                                                                                             | Run locally                                                                                                                                                                | CI job                                                             | Fails the run?                                                  |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| Lint / types / format   | ESLint, `tsc`, Prettier, rustfmt, clippy        | `eslint.config.mjs` (tests), `packages/tmuxy-ui/eslint.config.js` (+ `eslint-rules/`), `Cargo.toml` `[workspace.lints.clippy]` | Static gates; bans skipped tests and tmux shortcuts in E2E code                                                            | `npm run lint`, `npx tsc --noEmit` (in `packages/tmuxy-ui`), `cargo clippy -p tmuxy-core -p tmuxy-server -p tmuxy-tauri-app -p tmuxy-tree -p tmuxy-connect -- -D warnings` | `lint`                                                             | Yes                                                             |
| Rust unit + integration | `cargo test` (proptest, fixtures)               | `#[cfg(test)]` modules in every crate; `packages/tmuxy-core/tests/`                                                            | Parser, state aggregator, reflow, command routing, server/Tauri seams; five core integration tests drive a real `tmux -CC` | `cargo test --workspace` (needs `tmux` on PATH)                                                                                                                            | `rust-tests`                                                       | Yes                                                             |
| UI unit                 | Vitest + Testing Library, jsdom                 | `packages/tmuxy-ui/src/**/__tests__/`, `src/test/` (setup: `src/test/setup.ts`, config: `vite.config.ts`)                      | Pure logic, machine state handlers, adapters, a few mocked component renders, story smoke                                  | `npm test -- --run` (plain `npm test` watches)                                                                                                                             | `unit-tests`                                                       | Yes                                                             |
| CLI                     | Jest, mocked binaries                           | `tests/cli/` (`mocks/tmux`, `mocks/tmuxy-server`, `mocks/tmuxy-connect`)                                                       | `bin/tmuxy-cli` dispatch and argv; asserts every tmux call carries the dedicated socket flag                               | `npm run test:cli`                                                                                                                                                         | `cli-tests`                                                        | Yes                                                             |
| Storybook probe         | Playwright + `storybook dev`                    | `packages/tmuxy-ui/src/**/*.stories.tsx`, `scripts/probe-stories.mjs`                                                          | Every non-`v86` story renders and its play function passes (render, glitch, immediacy budgets)                             | `npm run storybook -w tmuxy-ui`, then `npm run test-storybook -w tmuxy-ui`                                                                                                 | `storybook-probe`                                                  | Yes                                                             |
| Storybook v86 probe     | Playwright, v86 + `tmuxy-wasm`                  | `v86`-tagged stories (`src/stories/App.stories.tsx`, `src/stories/DeltaProtocol.stories.tsx`), `scripts/probe-spikes.mjs`      | Real tmux behind the real UI with no server: optimistic updates, reconcile, `%output` rendering                            | `npm run test-storybook:v86 -w tmuxy-ui` (needs the assets below)                                                                                                          | `storybook-v86-probe`                                              | Gate step (3 stories): yes. Full sweep: nightly, blocking there |
| Web E2E                 | Jest + Playwright over CDP                      | `tests/1-…` to `tests/10-…`, `tests/helpers/`                                                                                  | Whole chain: keyboard/mouse in Chromium → server → tmux → SSE → DOM                                                        | `npm run test:e2e` (Chrome on 9222, see below)                                                                                                                             | `e2e` matrix, one runner per file (`2-layout` is split across two) | Yes                                                             |
| Snapshot                | Jest + Playwright                               | `tests/snapshots/snapshot.test.js`                                                                                             | Read-only UI ↔ tmux consistency checks (structure, then DOM invariants)                                                    | `npx jest tests/snapshots/`                                                                                                                                                | `e2e (snapshots)`                                                  | Yes                                                             |
| Interaction latency     | Playwright                                      | `packages/tmuxy-ui/scripts/measure-interactions.mjs`, `compare-interactions.mjs`, `perf/interaction-baseline.json`             | Cost of key-echo, pane nav, zoom, split, tab switch, as a ratio to a keystroke                                             | See [Interaction-Latency Tests](#interaction-latency-tests)                                                                                                                | `interaction-latency`                                              | Ratio budgets: yes. Absolute ms: warn only                      |
| Tauri E2E               | Jest + WebdriverIO + `tauri-driver`, Xvfb       | `tests/tauri/`                                                                                                                 | Desktop IPC seam (`invoke`/`listen`), app lifecycle, state sync. Linux/WebKitGTK only                                      | `npm run test:tauri` (Linux)                                                                                                                                               | `desktop`                                                          | Yes                                                             |
| Desktop smoke           | WebdriverIO, `tauri-driver` / `tauri-webdriver` | `tests/smoke/`                                                                                                                 | The packaged app launches, runs a command, connects once; launch-environment regressions                                   | Built by CI; `node tests/smoke/smoke-test.js <binary>` with a driver on 4444                                                                                               | `build-app.yml` `build` matrix                                     | `smoke-test.js` and macOS `macos-sparse-path-test.js`: yes      |
| Dependency audit        | `npm audit`, `cargo audit`                      | `.cargo/audit.toml`                                                                                                            | Production npm deps (high+) and the Rust workspace                                                                         | same commands                                                                                                                                                              | `audit`                                                            | Yes                                                             |

Not run by anything: the criterion benchmark `packages/tmuxy-core/benches/core_pipeline.rs` (see [PERFORMANCE.md](PERFORMANCE.md) Axis A). The manual QA-agent scripts (`tests/qa-*.js`) and `tests/tauri/trace-demo.js` were deleted rather than left to rot — ~1,480 lines no job had run in months.

### CI Workflows

| Workflow                               | Trigger                                               | Jobs                                                                                                                                                                                                                                                                          | Runner                                                     |
| -------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `.github/workflows/lint-and-tests.yml` | push to `main`, PRs to `main`                         | `build-artifacts` (frontend + release server, shared by the jobs below), `lint`, `unit-tests`, `macos-tests`, `rust-tests`, `cli-tests`, `demo-build`, `e2e` (matrix), `interaction-latency`, `desktop` (release Tauri build, smoke test + Tauri E2E), `storybook-probe`, `storybook-v86-probe`, `audit` | `ubuntu-latest`, plus `macos-latest` for `macos-tests`     |
| `.github/workflows/nightly-v86.yml`    | nightly cron, manual                                  | the full v86 story sweep; failures outside `scripts/probe-quarantine-v86.json` open an issue                                                                                                                                                                                  | `ubuntu-latest`                                            |
| `.github/workflows/nightly-tmux-matrix.yml` | nightly cron, manual                             | the tmux-facing suites against each supported tmux version; released versions gate, `HEAD` reports only                                                                                                                                                                       | `ubuntu-latest`                                            |
| `.github/workflows/build-app.yml`      | `v*` tags, daily cron, manual                         | `build` (Tauri build + smoke tests) + `upgrade-path`, then on tags `release`, `bump-cask`, `bump-formula`                                                                                                                                                                     | `ubuntu-22.04` (amd64), `ubuntu-22.04-arm`, `macos-latest` |
| `.github/workflows/nightly-perf.yml`   | manual only                                           | the criterion core bench and an interaction-baseline refresh — both report a number for a human, neither gates                                                                                                                                                               | `ubuntu-latest`                                            |
| `.github/workflows/deploy-demo.yml`    | push to `main` touching the demo or UI source, manual | demo build + Pages deploy (no tests)                                                                                                                                                                                                                                          | `ubuntu-latest`                                            |

**"Blocking" means the job turns the run red — nothing is enforced at merge.** `main` has no branch protection or required status checks; its only ruleset blocks deletion and force-push. Nothing in the PR run is non-blocking any more: the suites that used to be waved through (`9-animations`, `hostile-config-test.js`) were deleted rather than left reporting a result nobody could act on, and the v86 sweep moved to its own nightly workflow where it blocks and opens an issue.

Quarantine is the one deliberate exception, and it is bounded: a story listed in `packages/tmuxy-ui/scripts/probe-quarantine.json` (deterministic probe) or `packages/tmuxy-ui/scripts/probe-quarantine-v86.json` (the nightly v86 sweep) still runs and is still reported, but does not fail the job until its expiry date, after which it blocks again. Both lists are capped, and every entry carries a reason and an ISO expiry — `scripts/probe-quarantine.mjs` enforces that and refuses to run on a list that breaks it.

Jobs that need tmux build **3.7a** from source and cache it (`e2e`, `interaction-latency`, `desktop`, `rust-tests`). The macOS smoke test uses Homebrew's `tmux` and the Linux smoke test apt's `tmux`.

### Local Gates

`.github/pre-commit` (enabled by `npm install` through the `prepare` script) runs Prettier and `eslint --fix` on `packages/tmuxy-ui/src`, `eslint tests/`, a check that `eslint.config.mjs` still bans `tmuxQuery`, `vitest related --run` for staged UI sources, `cargo fmt -p tmuxy-core -p tmuxy-server` and `cargo clippy -p tmuxy-core -p tmuxy-server`. Formatter rewrites are re-staged only for fully staged files.

ESLint rules that exist to protect test quality (`eslint.config.mjs`):

- `jest/no-disabled-tests` is an error for `tests/**/*.js`.
- `tests/helpers/pane-ops.js`, `tests/helpers/keyboard.js` and every `tests/**/*.test.js` outside `tests/tauri/` may not call `tmuxQuery`/`tmuxRun`, `execSync` or import `child_process`. Setup and ground-truth reads go through `tmuxExec()` in `tests/helpers/tmux-socket.js`.

Clippy warns on `unwrap_used` and `expect_used` workspace-wide; CI promotes all warnings to errors. Test files opt out explicitly with an `allow` attribute.

## Which Layer Does a New Test Go In?

Pick the cheapest layer that can still fail for the bug you care about. If the bug lives in the chain between two layers, the test belongs in the layer that contains the whole chain.

| The behavior is…                                                                                                               | Put the test in                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A pure function, parser or state transition in TypeScript (layout math, copy-mode engine, key mapping, a machine handler)      | Vitest, next to the code in `__tests__/`                                                                                                    |
| Rust parsing, aggregation, reflow or routing that can be fed recorded control-mode text                                        | `cargo test` — a `#[cfg(test)]` module, or `packages/tmuxy-core/tests/` with a fixture                                                      |
| Rust behavior that depends on how real tmux answers or orders replies                                                          | `packages/tmuxy-core/tests/` against a scratch socket, like `reply_channel.rs`                                                              |
| What the `tmuxy` CLI sends to tmux                                                                                             | `tests/cli/`                                                                                                                                |
| How a component looks or animates, render counts, flicker, optimistic paint timing with controlled latency or forced rejection | A Storybook story with a play function on `AppHarness`/`ProviderHarness` (`src/stories/StoryHarness.tsx`)                                   |
| "tmux did X and the UI showed it" without needing the Rust server or HTTP                                                      | A `v86`-tagged story on `V86AppHarness`                                                                                                     |
| A user-visible feature through the real server and transport: keyboard, mouse, touch, floats, groups, reconnect, OSC, widgets  | Web E2E — extend the numbered file whose theme fits (below); a production bug with no better home goes in `tests/7-regression-bugs.test.js` |
| Something that got slower but still works                                                                                      | An entry in `measure-interactions.mjs` plus a budget in `compare-interactions.mjs`                                                          |
| Anything that differs on desktop: IPC commands, events, app lifecycle                                                          | `tests/tauri/tauri-app.test.js`                                                                                                             |
| The packaged app failing to start in a particular launch environment                                                           | `tests/smoke/`                                                                                                                              |

Whatever the layer, the rules below apply: assert what the user sees, drive it through the user's path, and keep one feature in one test. A unit or story test does not replace an E2E test for a user path — it catches the bug earlier and cheaper.

## Core Principle: Test What the User Sees

A test passes when a real user would say "this works." A test that checks internal state while the feature is visually broken is worse than no test — it creates false confidence.

Every assertion must answer: **"If this assertion passes but everything else about the feature is wrong, would a user still consider it working?"** If the answer is no, the assertion is testing an implementation detail, not the feature.

## The DOM Trap

The most common failure mode in UI testing is asserting against the DOM instead of what the user perceives. The DOM and the rendered output can disagree in many ways:

- An element exists but is **clipped** by `overflow: hidden` on a parent
- An element has the correct text but is **off-screen** or **zero-sized**
- A CSS property has the right value in `getComputedStyle` but a parent's style **overrides it visually** (opacity, visibility, display, z-index)
- Content is in the DOM but **behind another element** (z-index, overlapping absolutes)
- An element is **positioned outside its container** due to double-positioning bugs

**Rules:**

1. After checking that an element exists, always verify it is **visually present**: bounding rect has non-zero width/height, it is within the viewport, and it is not obscured.
2. Never trust `textContent` alone. If the test claims "output is visible," verify the element containing that text has a visible bounding rect.
3. Never trust `getComputedStyle` alone. A green border on an element clipped to 0px height is not a green border.
4. When testing content rendering (e.g., "type a command and see output"), verify the content container has **visible dimensions** and the text is within the visible region.

## Test What the Feature Does, Not How It Works

Bad test: "After split-window, XState context has 2 panes and the DOM has 2 `.pane-layout-item` elements."
Good test: "After split-window, two terminal areas are visible, each with non-zero size, and typing in one does not affect the other."

Bad test: "Float pane has `border-color: rgb(0, 205, 0)` in computed style."
Good test: "Float pane is visible (has area > 0), shows terminal content, and accepts keyboard input that produces visible output."

The bad tests would pass even if the float were invisible due to overflow clipping. The good tests would catch it.

## User Paths Over Adapter Calls

Tests should exercise features the way a user would trigger them, not the way the code internally implements them.

- If a user creates a float by typing `tmuxy pane float` in the terminal, the test should type that command in the terminal — not call `ctx.session._exec('break-pane ...')`.
- If a user closes a float by clicking the X button, the test should click the X button — not call `tmux kill-window`.
- If a keyboard shortcut triggers an action, the test should press that keyboard shortcut.

When a test uses an internal adapter call instead of the real user path, it skips the entire chain that can break: shell script execution, tmux command routing, control mode event propagation, React state updates, and DOM rendering. This is exactly the chain where bugs live.

**Exception:** Setup steps that aren't part of the feature under test can use adapter calls for speed. For example, splitting panes as a prerequisite for testing float behavior is fine via adapter. But the float creation itself must go through the user path.

## One Feature, One Test

Each test should cover one user-visible behavior end-to-end. Do not split a feature into "check state" and "check DOM" and "check style" as separate tests — that creates the illusion of coverage while missing the integration between them.

A float pane test should, in a single test:

1. Create the float (via user path)
2. Verify it appeared visually (bounding rect, visible content)
3. Interact with it (type, see output)
4. Close it (via user path)
5. Verify it is gone

Do not write five separate tests for these steps. The value is in the chain.

## Assertions That Catch Real Bugs

For every assertion, ask: **"What bug would make this assertion fail?"** If you cannot name a specific, plausible bug, the assertion is not useful.

| Assertion                                               | Bug it catches                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Float container bounding rect > 100x100                 | Overflow clipping, zero-height parent, missing content              |
| Typed text appears within the visible area of the float | Keyboard routing broken, content not rendering, wrong pane targeted |
| Float is gone after close AND no orphan tmux window     | Close handler broken, tmux window leak                              |
| Background pane still interactive after float closes    | Focus not restored, keyboard routing stuck                          |

| Assertion                                    | What it does NOT catch                      |
| -------------------------------------------- | ------------------------------------------- |
| `getComputedStyle(fc).borderColor === green` | Border on invisible element                 |
| `log.textContent.includes(token)`            | Text in DOM but clipped/hidden              |
| `floatPanes.length === 1`                    | Float exists in state but not rendered      |
| `focusedFloatPaneId !== null`                | Focus set but keyboard not actually routing |

## E2E Tests

### Suites

`npm run test:e2e` runs every `*.test.js` under `tests/` except `tests/cli/` and `tests/tauri/` (`jest.config.js`). In CI each file below is its own matrix entry.

| File                                   | Covers                                                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/1-input-interaction.test.js`    | Keyboard, paste, international input, mouse click/scroll/drag/SGR, mouse selection, copy mode navigate/yank, touch scroll (CDP touch events), viewport resize at 800x600 and 1920x1080                                  |
| `tests/2-layout-navigation.test.js`    | Windows/tabs, tab overview, marked and collapsible panes, zoom, drag to tab strip, pane groups, float lifecycle and close paths, sidebar tree, pinned dock, status bar, fzf in a float                                  |
| `tests/3-rendering-protocols.test.js`  | OSC 8 hyperlinks, OSC 52 clipboard, Unicode, SGR faint, image protocols, browser widget                                                                                                                                 |
| `tests/4-session-connectivity.test.js` | Reload preserves state, offline/online connection overlay, multi-client, command routing, multi-session sidebar                                                                                                         |
| `tests/5-stress-stability.test.js`     | Large output (`yes \| head -500`, `seq 1 2000`), rapid operations, glitch detection                                                                                                                                     |
| `tests/6-nvim-performance.test.js`     | One nvim boot: rendering a 500-line file, cursor shape (DECSCUSR) through insert mode, half-page scrolling, discarding the edit                                                                                         |
| `tests/7-regression-bugs.test.js`      | One scenario per production bug the other suites missed                                                                                                                                                                 |
| `tests/8-tui-alternate-screen.test.js` | Heavy alt-screen TUI (`tests/fixtures/heavy-tui.sh`) compared line by line with `capture-pane`; wheel to a mouse-tracking TUI started before attach                                                                     |
| `tests/10-read-only.test.js`           | A `--read-only` server beside the writer: the viewer follows output, keeps its own tab and pane, and can neither type nor resize nor change anything                                                                    |
| `tests/11-webkit.test.js`              | The same selection, copy and focus flows under Playwright WebKit — the only proxy CI has for WKWebView, where those bugs escaped. Skips loudly when WebKit is absent; `TMUXY_E2E_REQUIRE_WEBKIT=1` makes that a failure |
| `tests/12-touch.test.js`               | One phone-width (400x780) `hasTouch` context: tap to focus the hidden input, swipe to open the scroll view, tap targets in the tab strip, no horizontal overflow                                                        |
| `tests/snapshots/snapshot.test.js`     | Read-only UI ↔ tmux comparison, no interactions                                                                                                                                                                         |

Helpers live in `tests/helpers/`, one file per domain: `browser.js` (CDP connect or launch), `test-setup.js` (`createTestContext`), `extra-server.js` / `read-only-server.js` / `public-name-proxy.js` (a second server beside the suite's own), `TmuxTestSession.js`, `keyboard.js`, `pane-ops.js`, `window-ops.js`, `pane-groups.js`, `copy-mode.js` / `copy-mode-ui.js`, `mouse-capture.js`, `cell-grid.js`, `layout.js`, `glitch-detector.js`, `snapshot-compare.js`, `content-match.js`, `consistency.js`, `performance.js`, `ui.js`, `cli.js`, `tmux-socket.js`, `config.js`. Import them through `tests/helpers/index.js`.

### Environment

- Tests connect to an existing Chrome via CDP on port 9222 — never install Playwright browsers locally (CI provisions its own chromium; that's the one exception)
- All E2E tests run sequentially (`maxWorkers: 1`) — they share one tmux server
- A tmuxy server must be reachable on `TMUXY_PORT` (default 9000, `tests/helpers/config.js`); the suite builds and starts one itself if nothing answers
- Missing prerequisites FAIL the run. A suite that cannot reach Chrome or the server used to skip every test and report green, which is worse than a red: it says a suite ran that never did. Set `TMUXY_E2E_ALLOW_SKIP=1` to opt into the old behaviour

### What the helpers guarantee

Three rules live in `tests/helpers/` rather than in each test, so a fix lands once instead of ninety times:

- **Text has to be on screen to count.** `getTerminalText` and `waitForTerminalText` read only the terminals the user can actually see — a pane in a background tab, a parked pane-group member and a closed sidebar all keep their content mounted, and joining all of them let a test pass on text nobody could read. `waitForTerminalText` goes further and checks the line carrying the text has a real box, inside its pane and inside the viewport. Pass `{ scope }` to narrow to one pane (`'.pane-active'`, or `[data-pane-id="%3"]`)
- **Wait for the state, don't sleep.** `waitForLayoutSettled` returns once the panes, their boxes and the focus have been the same twice in a row; every helper that changes the layout (split, nav, swap, zoom, kill, layout cycle) ends with it instead of a flat 500ms. `typeInTerminal` waits for the app to be holding the keyboard rather than sleeping before it types
- **Teardown waits for the monitor, not a clock.** `afterEach` polls tmux until the session is gone and no client is left attached to it. That was a flat `delay(4000)` — about 6.5 minutes of pure sleep across the suite, and a coupling where one test's slow shutdown failed the next one

Start the Chrome the tests attach to with any system Chrome/Chromium:

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tmuxy-e2e-chrome --no-first-run --no-default-browser-check &
curl -s http://127.0.0.1:9222/json/version   # confirm it answers before running the suite
```

**Confirm that Chrome is up first.** Without it the suite does not fail — every test calls `skipIfNotReady()` and reports green in a couple of milliseconds, which looks identical to a real pass. A suite finishing suspiciously fast is the tell. (`CI=1` turns the skip into a hard failure, which is why CI can't be fooled this way.)

The suite pins `TMUX_SOCKET` to **`tmuxy-test`** and clears `$TMUX` in `tests/jest.setup.js` (the default lives in `tests/helpers/tmux-socket.js`), so it is safe to run from inside a tmux pane: it creates and kills sessions on a socket of its own, never the `tmuxy` socket a running tmuxy — quite possibly the one you are sitting in — is serving.

**The server under test has to be on that socket too.** It is the other half of every round trip: a server attached elsewhere leaves the tests reading and writing different tmux servers, and every one of them fails at "session not found" while the UI looks perfectly healthy. The suite gets this right on its own — a server it starts inherits the pinned socket, and CI sets `TMUX_SOCKET` for the whole e2e job. Only a server you started by hand can diverge, so start it to match:

```bash
TMUX_SOCKET=tmuxy-test ./target/release/tmuxy-server   # or just let the suite start its own
```

The setup step warns when it reuses a server it did not start, because a running server reports no socket and the mismatch cannot be detected — only flagged.

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

| Instead of                                     | Also assert                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| The element handle is not null                 | Its `boundingBox()` exists with width and height above a meaningful floor (e.g. 50px) |
| A container's `textContent` contains the token | That same container's `getBoundingClientRect()` has visible width and height          |

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

## Storybook Tests

Three tiers, cheapest first. All play functions follow the same rules as E2E tests (real user paths, visible-rect assertions, unique sentinels).

| Tier                                                          | What runs                                                                                                                                                | Where                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vitest smoke (`src/stories/__tests__/stories.smoke.test.tsx`) | Pure component stories render in jsdom; provider-backed stories are only imported and composed (mounting them exhausts the heap)                         | `npm test` (CI: `unit-tests`)                                                                                                                                                                                                       |
| Deterministic probe (`npm run test-storybook -w tmuxy-ui`)    | Every non-`v86` story + its play function, fresh Chromium page each, 1280x800, 3 at a time                                                               | CI: `storybook-probe` (blocking)                                                                                                                                                                                                    |
| v86 probe (`npm run test-storybook:v86 -w tmuxy-ui`)          | Every `v86`-tagged story on ONE shared page (real tmux in the x86 emulator, snapshot-reset between stories; periodic cold-boot to cap accumulated drift) | CI: `storybook-v86-probe` runs three gate stories (`split-optimistic-timeline`, `split-rejected-rollback`, `resize-pane-drag`), blocking. The full sweep moved to the nightly `nightly-v86.yml`, where it blocks and opens an issue |

The `v86` tier needs two gitignored artifact sets that Storybook mounts as static dirs (`.storybook/main.ts`): `packages/tmuxy-wasm/pkg` from `npm run build:wasm` (needs the `wasm32-unknown-unknown` target and a `wasm-bindgen` CLI matching the version in `Cargo.lock`), and `packages/tmuxy-ui/v86-assets` from `npm run fetch:v86-image -w tmuxy-ui` plus `npm run build:v86-snapshot -w tmuxy-ui` (needs the `i686-unknown-linux-musl` target for the guest `tmuxy-tree` and `zstd`). Without them the `V86AppHarness` stories render the app's Connection Error screen with a failed dynamic import of `/wasm/tmuxy_wasm.js`. Both directories must at least exist for Storybook to start; the `storybook-probe` CI job creates them empty because it only runs the deterministic tier. The `v86` tag is set at the meta level of a story file; `probe-stories.mjs` excludes it and `probe-spikes.mjs` selects it.

**Seeing the raw tmux TUI.** The toolbar's "tmux view" global (`.storybook/preview.ts`, decorator in `src/stories/tmuxView.tsx`) attaches a second, read-only tmux client on the guest's VGA console and shows v86's rendering of it — tmux drawing its own borders, status line and cursor, no tmuxy code involved — either beside the story or as a cell-aligned translucent overlay. It applies to the shared-engine `Scenarios/Application` stories; use it to eyeball what tmux thinks the screen looks like versus what tmuxy rendered.

Both probes expect a running Storybook (`npm run storybook -w tmuxy-ui`). CI runs the **dev** server (no build step needed; on-demand compilation). Filter either probe to specific stories by id substring: `npm run test-storybook:v86 -w tmuxy-ui -- split-optimistic deltaprotocol`. Set `PROBE_TIMINGS_JSON=<path>` to write per-story timings.

### When the probe goes red

The probe used to report `playFunctionThrewException` and nothing else, which is why it became the single biggest source of red `main`. It now writes a screenshot, a DOM dump and the real error with its stack to `packages/tmuxy-ui/probe-artifacts/` (gitignored, uploaded by CI on failure), and prints page and console errors.

To reproduce a CI failure locally, the knobs are `PROBE_REPEAT`, `PROBE_CONCURRENCY`, `PROBE_CPU_THROTTLE` (renderer throttling — a loaded runner is usually what a "flaky" story is actually reacting to) and `PROBE_A11Y=0`.

**Quarantine** (`packages/tmuxy-ui/scripts/probe-quarantine.json`) is the one way a known failure stops gating, and it is deliberately hard to abuse: every entry needs a reason and a `YYYY-MM-DD` expiry, after which it blocks again; there is a hard cap on how many entries may exist; and a malformed or over-cap file makes the probe exit without running anything. A quarantined story still runs and is still reported — it just does not fail the job, and it is listed as ready to remove once it passes.

### Accessibility

Every story is scanned with axe-core (already installed via `@storybook/addon-a11y`) once its play function settles. **`critical` and `serious` violations fail the job; `moderate` and `minor` are printed only.** A story that navigates its own page is recorded as skipped rather than failed. `Mocked App/Sidebar → TabOrderNeverTrapsTheKeyboard` is the keyboard-only check: it tabs through the chrome and asserts focus moves, is visible at every stop, never repeats before wrapping and is never trapped.

### Choosing a harness

Both are in `src/stories/StoryHarness.tsx`.

- **`AppHarness` / `ProviderHarness`** (DemoAdapter, deterministic): component behavior, optimistic-update timing that needs controlled latency (`commandDelayMs`) or forced rejections (`failCommand`), render budgets.
- **`V86AppHarness`** (real tmux): anything whose bugs live in the real chain — command transport, control-mode parsing, reconcile timing, `%output` rendering. If a story asserts "tmux did X", it belongs here.

### Immediacy assertions (optimistic rendering)

"Immediate" is measured, not assumed: arm `armPaintProbe` (`src/stories/immediacy.ts`) just before the input, and assert the first matching DOM mutation lands within a few animation frames (≤5 absorbs userEvent dispatch overhead; a real round-trip takes dozens). A painted `__placeholder_*` pane id is itself proof of optimism — the server never emits one. After the optimistic paint, assert the reconcile is invisible: no pane-node removals (`LayoutMutationRecorder`), no highlight flaps (record the class/attribute history with a MutationObserver — polling misses one-frame reverts).

### Glitch budgets

`src/stories/glitchRecorder.ts` is the story-side counterpart of `tests/helpers/glitch-detector.js`: MutationObserver-based node-flicker/attribute-churn detection plus rAF rect sampling for size jumps. Budgets are code: both harnesses read `src/stories/glitch-thresholds.json` — loosening a budget is a reviewable diff, not a silent drift.

`src/stories/resizeGlitch.ts` (`ResizeGlitchRecorder`) is the resize-specific counterpart: it logs every pane's `top`/`left`/`width`/`height` — from both the inline-`style` MutationObserver (every React commit, so a 1-frame revert can't hide) and an rAF rect sampler — and flags any A→B→A _reversal_. A threshold-on-consecutive-frames detector misses these; a value that leaves and returns does not. It samples the outer box (top/left/width/height, via style + rAF) AND each pane's terminal-content top (`[role=log]`) — the content shifts a row when the header appears/disappears even while the box stays the same size. Because the resize stories drive a MONOTONIC drag, any reversal is a real glitch: a mid-drag grid shift, the pane flashing back to an old size after mouse-up, or an uninvolved pane's content jumping up a row. See `Scenarios/Application` → `ResizePaneDrag` (horizontal), `ResizePaneDragVertical` (stacked), `ResizePaneDragGrid` (2x2 tiled — a whole-band resize).

### Render budgets

`src/utils/renderLog.tsx` places `LogProfiler` markers inside key components; each marker records one entry per RENDER of its host component to `window.__tmuxyRenderLog` when a story enables it (`enableRenderLog()` before mount). Budgets assert render counts per component id (e.g. typing into pane A must not render `Pane:B` or `WindowTabs`). React's own `<Profiler onRender>` is deliberately not used — it over-reports in this tree, firing for subtrees that fully bailed out. MutationObserver cannot see this class of waste — a re-render that produces identical DOM still costs CPU.

## UI Unit Tests

- Vitest with jsdom, configured in `packages/tmuxy-ui/vite.config.ts`; `src/test/setup.ts` installs jest-dom matchers, an in-memory `localStorage` for Node ≥ 22, and cleans up after each test
- Tests live beside the code in `__tests__/` directories: `src/utils/`, `src/machines/` (state handlers share `src/machines/app/states/__tests__/testHarness.ts`), `src/tmux/` (adapters, key batching, the store, the demo backend), `src/components/`, `src/hooks/`
- Test pure logic: parsers, state transformations, utility functions, adapter protocol handling
- Component rendering in jsdom is limited to a few mocked-context tests in `src/test/` and the story smoke test. jsdom has no layout, so a jsdom render test can prove "does not throw" and "renders this text", never "is visible" — anything visual belongs in a story or E2E
- Keep unit tests fast (< 1s per file)

## Rust Tests

- `cargo test --workspace` runs every crate's `#[cfg(test)]` modules plus the integration tests in `packages/tmuxy-core/tests/`. Most of the count is in `tmuxy-core`; `tmuxy-server`, `tmuxy-tauri-app`, `tmuxy-connect` and `tmuxy-wasm` have smaller suites; `tmuxy-tree` has none
- Prefer fixtures over a live tmux: `control_mode_push_api.rs` feeds recorded `tmux -CC` text through the parser and aggregator, `terminal_fidelity.rs` and `pane_reflow_parity.rs` replay byte streams through the emulator (`tests/fixtures/`), and `state_aggregator_props.rs` is a proptest suite (its regressions file is committed)
- `initial_state.rs`, `initial_state_history.rs`, `reply_channel.rs`, `pinned_split_race.rs` and `enforced_settings.rs` drive a real `tmux -CC` monitor on a per-process scratch socket and need a `tmux` binary; use that pattern only when the bug depends on how tmux itself answers
- Test code opts out of the `unwrap_used`/`expect_used` lints with an `allow` attribute

## CLI Tests

`tests/cli/` has its own Jest config (`tests/cli/jest.config.js`) and runs `bin/tmuxy-cli` against the mock `tmux`, `tmuxy-server` and `tmuxy-connect` scripts in `tests/cli/mocks/`, which log every invocation. `tests/cli/helpers/run-cli.js` fails any recorded tmux call that does not lead with the dedicated socket flag, so socket isolation is enforced for every subcommand. It is hermetic: no tmux, no server, no browser.

## Interaction-Latency Tests

A separate CI job (`interaction-latency` in `lint-and-tests.yml`) times the
interactions a user performs constantly — typing, moving between panes,
splitting, zooming, switching tabs — through the same real keyboard path the
E2E suites use, and gates on how expensive each one is **relative to a single
keystroke round trip measured in the same run**. That ratio is what survives
runner load; absolute milliseconds are recorded as a trend only. It exists to
catch the class of regression the functional suites pass straight through: the
feature still works, it just costs three times what it used to.

Adding an interaction means adding one entry in
`packages/tmuxy-ui/scripts/measure-interactions.mjs` (how to trigger it, and
the visible thing that says it happened) and one budget in
`compare-interactions.mjs`. See [PERFORMANCE.md](PERFORMANCE.md) § Axis C for
the design and the current numbers. The other harnesses in that directory
(`measure-latency.mjs`, `measure-keypaint.mjs`, `latency-proxy.mjs`) are manual
Axis A/B tools and are not run in CI.

## Desktop (Tauri) Tests

The desktop app wraps the same React UI with native IPC instead of HTTP/SSE, so desktop tests cover the seam, not the UI again.

- **Tauri E2E** (`tests/tauri/tauri-app.test.js`): Jest → WebdriverIO → `tauri-driver` on port 4444 → WebKitWebDriver → a debug build at `target/debug/tmuxy`. The global setup builds the frontend and the binary, starts Xvfb on `:99` and the driver; each test launches a fresh app with its own session. Covers app lifecycle, IPC commands through `invoke()`, events through `listen()`, and state sync. Linux only (WebKitGTK and Xvfb).
- **Smoke tests** (`tests/smoke/`, run by `build-app.yml` after the release build and by `desktop` on PRs): `smoke-test.js` launches the app on Linux (`tauri-driver` + Xvfb) and macOS (`tauri-webdriver` against a debug build with `--features webdriver`), answers the first-run notice, types a command, sees the output, and reads `~/tmuxy-debug.log` to require no `FATAL` and at most two control-mode connects. `macos-sparse-path-test.js` launches the release binary under launchd's sparse `PATH` and requires a stable connection.
- Visual behavior assertions follow the same guidelines as E2E (verify visible, not just in DOM).

## What Not to Test

- Framework behavior (React renders components, XState transitions on events)
- CSS values in isolation (computed styles without visual verification)
- Internal state that has no user-visible consequence
- Implementation details that could change without affecting the user experience
- Third-party libraries doing what their docs say they do

## Running Tests

```bash
npm run lint                               # ESLint: tests/ and tmuxy-ui
npm test -- --run                          # Vitest once (without --run it watches)
cargo test --workspace                     # Rust (needs tmux on PATH)
npm run test:cli                           # CLI suite, hermetic

npm run test:e2e                           # Web E2E + snapshots; starts its own server if needed
npx jest tests/2-layout-navigation.test.js # One E2E file

npm run storybook -w tmuxy-ui              # Storybook dev server (required for probes)
npm run test-storybook -w tmuxy-ui         # Probe all non-v86 stories
npm run test-storybook:v86 -w tmuxy-ui     # Probe v86 stories (shared engine)

npm run test:tauri                         # Tauri E2E (Linux: tauri-driver, Xvfb, webkit2gtk-driver)

# Interaction latency (needs a running server; --cdp reuses the dev browser)
npm run perf:interactions -- --url http://localhost:9000 --out perf/interaction-report.json
npm run perf:compare -- --report perf/interaction-report.json
```

## Debugging

```bash
# Single scenario by name
npm run test:e2e -- --testNamePattern="Scenario 22"

# Verbose output
npm run test:e2e -- --verbose
```

When CI's E2E or latency job fails, its last step prints the tail of the server log (`/tmp/tmuxy-server.log`). A local suite-started server writes stderr to `/tmp/tmuxy-server-stderr.log`.

## Known Gaps

Facts as of this writing; the ones marked _unverified_ could not be confirmed from the repository alone.

| Gap                                               | Evidence                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No check is required to merge                     | `main` has no branch protection; its ruleset only blocks deletion and force-push. A red `lint-and-tests` run does not stop a merge.                                                                                                                                                                                                      |
| The packaged macOS app is only tested after merge | The Linux desktop smoke test runs on PRs (`desktop` in `lint-and-tests.yml`), but `build-app.yml` — which builds the macOS app and runs the sparse-PATH test — triggers only on tags, a daily cron and manual dispatch. Dispatch it before tagging when a change touches the desktop app or packaging.                              |
| macOS WKWebView gets no functional desktop suite  | `tests/tauri/` is Linux-only (`tests/tauri/helpers/xvfb.js`, `tests/tauri/helpers/tauri-driver.js`); macOS only gets `tests/smoke/smoke-test.js`, post-merge.                                                                                                                                                                            |
| No phone-width coverage                           | E2E pages open at 1280x720 (`tests/helpers/browser.js`); the smallest viewport tested is 800x600 (`tests/1-input-interaction.test.js`, Scenario 23); both probes use 1280x800. No mobile or `hasTouch` browser context exists. Touch is covered only by CDP touch scroll (Scenario 21) and `src/utils/__tests__/mobileKeyboard.test.ts`. |
| Output flood tests are light                      | The heaviest is `tests/5-stress-stability.test.js` Scenario 17: `yes \| head -500` and `seq 1 2000`. No sustained, multi-megabyte or backpressure test exists, and the latency gate measures no output throughput.                                                                                                                       |
| The Axis A benchmark is not in CI                 | `packages/tmuxy-core/benches/core_pipeline.rs` is run by hand; `PROBE_TIMINGS_JSON` from `probe-spikes.mjs` is not collected by any job.                                                                                                                                                                                                 |
| Uncovered crates and scripts                      | `packages/tmuxy-tree` has no tests; `packages/tmuxy-demo` has none and `deploy-demo.yml` deploys without testing; the `tests/qa-*.js` scripts and `tests/tauri/trace-demo.js` are run by no job.                                                                                                                                         |
| Clippy is not run over test code                  | CI runs `cargo clippy` without `--tests`, so lints in `#[cfg(test)]` modules and `tests/` go unchecked — `packages/tmuxy-core/tests/control_mode_push_api.rs` is missing the `allow` attribute every sibling has and would fail today.                                                                                                   |

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — the components each test tier covers
- [PERFORMANCE.md](PERFORMANCE.md) — the benchmark and probe harnesses that share this infrastructure
- [COPY-MODE.md](COPY-MODE.md) — how to drive copy mode from a test through real user input
- [TMUX.md](TMUX.md) — the control-mode constraints test sessions must respect
