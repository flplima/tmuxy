# Testing Guidelines

Principles and rules for writing tests in tmuxy. Applies to all test types: E2E, integration, unit, and Tauri.

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

| Assertion | Bug it catches |
|-----------|---------------|
| Float container bounding rect > 100x100 | Overflow clipping, zero-height parent, missing content |
| Typed text appears within the visible area of the float | Keyboard routing broken, content not rendering, wrong pane targeted |
| Float is gone after close AND no orphan tmux window | Close handler broken, tmux window leak |
| Background pane still interactive after float closes | Focus not restored, keyboard routing stuck |

| Assertion | What it does NOT catch |
|-----------|----------------------|
| `getComputedStyle(fc).borderColor === green` | Border on invisible element |
| `log.textContent.includes(token)` | Text in DOM but clipped/hidden |
| `floatPanes.length === 1` | Float exists in state but not rendered |
| `focusedFloatPaneId !== null` | Focus set but keyboard not actually routing |

## E2E Tests

### Environment

- Tests connect to an existing Chrome via CDP on port 9222 — never install Playwright browsers locally (CI provisions its own chromium; that's the one exception)
- All E2E tests run sequentially (`maxWorkers: 1`) — they share one tmux server
- Dev server must be running (`npm start`)

Start the Chrome the tests attach to with any system Chrome/Chromium:

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/tmuxy-e2e-chrome --no-first-run --no-default-browser-check &
curl -s http://127.0.0.1:9222/json/version   # confirm it answers before running the suite
```

**Confirm that Chrome is up first.** Without it the suite does not fail — every test calls `skipIfNotReady()` and reports green in a couple of milliseconds, which looks identical to a real pass. A suite finishing suspiciously fast is the tell. (`CI=1` turns the skip into a hard failure, which is why CI can't be fooled this way.)

The suite pins `TMUX_SOCKET` to `tmuxy` and clears `$TMUX` in `tests/jest.setup.js`, so it is safe to run from inside a tmux pane: mutations go to the dedicated socket rather than the session you are sitting in.

### Session Lifecycle

- Each **test** gets a fresh tmux session: `createTestContext()`'s `beforeEach` creates a `TmuxTestSession`, and `afterEach` destroys it
- Never leave tmux sessions or windows behind — the context's `afterEach`/`afterAll` handle cleanup; don't bypass them

### Timing

- Use `waitForCondition` or `page.waitForFunction` with explicit conditions instead of `delay()`
- When you must wait, prefer polling for the expected state over sleeping a fixed duration
- Flaky waits indicate the test is not waiting for the right condition

### Visual Verification Helpers

Every E2E test that creates UI elements should verify they are visually present. Use bounding-rect checks:

```
// Instead of just checking DOM existence:
const el = await page.$('.float-container');
expect(el).not.toBeNull();  // NOT ENOUGH

// Verify it is actually visible:
const rect = await el.boundingBox();
expect(rect).not.toBeNull();
expect(rect.width).toBeGreaterThan(50);
expect(rect.height).toBeGreaterThan(50);
```

For content visibility, verify the text is inside a visible container:

```
// Instead of just checking textContent:
const text = await page.evaluate(() =>
  document.querySelector('.float-container [role="log"]')?.textContent
);
expect(text).toContain(token);  // NOT ENOUGH

// Also verify the container is visible:
const logRect = await page.evaluate(() => {
  const el = document.querySelector('.float-container [role="log"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: r.width, h: r.height };
});
expect(logRect.w).toBeGreaterThan(50);
expect(logRect.h).toBeGreaterThan(50);
```

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

Never commit `it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, or `xdescribe`. ESLint enforces this via `jest/no-disabled-tests` (error). Fix the test, fix the bug, or remove the test entirely.

## Storybook Tests

Three tiers, cheapest first. All play functions follow the same rules as E2E tests (real user paths, visible-rect assertions, unique sentinels).

| Tier | What runs | Where |
|------|-----------|-------|
| Vitest smoke (`stories/__tests__/stories.smoke.test.tsx`) | Pure component stories render; provider stories compose | `npm test` (CI: unit-tests job) |
| Deterministic probe (`npm run test-storybook -w tmuxy-ui`) | Every non-`v86` story + its play function, fresh Chromium page each | CI: storybook-probe job |
| v86 probe (`npm run test-storybook:v86 -w tmuxy-ui`) | Every `v86`-tagged story on ONE shared page (real tmux in the x86 emulator, snapshot-reset between stories; periodic cold-boot to cap accumulated drift) | CI: storybook-v86-probe job (**non-blocking** — inherently timing-sensitive at scale; reports for triage) |

The `v86` tier needs two gitignored artifact sets that Storybook mounts as static dirs (`.storybook/main.ts`): `packages/tmuxy-wasm/pkg` from `npm run build:wasm` (needs the `wasm32-unknown-unknown` target and a `wasm-bindgen` CLI matching the version in `Cargo.lock`), and `packages/tmuxy-ui/v86-assets` from `npm run fetch:v86-image -w tmuxy-ui` plus `npm run build:v86-snapshot -w tmuxy-ui` (needs the `i686-unknown-linux-musl` target for the guest `tmuxy-tree` and `zstd`). Without them the `V86AppHarness` stories render the app's Connection Error screen with a failed dynamic import of `/wasm/tmuxy_wasm.js`. Both directories must at least exist for Storybook to start; the `storybook-probe` CI job creates them empty because it only runs the deterministic tier.

**Seeing the raw tmux TUI.** The toolbar's "tmux view" global (`.storybook/preview.ts`, decorator in `stories/tmuxView.tsx`) attaches a second, read-only tmux client on the guest's VGA console and shows v86's rendering of it — tmux drawing its own borders, status line and cursor, no tmuxy code involved — either beside the story or as a cell-aligned translucent overlay. It applies to the shared-engine `Scenarios/Application` stories; use it to eyeball what tmux thinks the screen looks like versus what tmuxy rendered.

Both probes expect a running Storybook (`npm run storybook -w tmuxy-ui`). CI runs the **dev** server (no build step needed; on-demand compilation). Filter the v86 probe to specific stories by id substring: `npm run test-storybook:v86 -- split-optimistic deltaprotocol`.

### Choosing a harness

- **`AppHarness` / `ProviderHarness`** (DemoAdapter, deterministic): component behavior, optimistic-update timing that needs controlled latency (`commandDelayMs`) or forced rejections (`failCommand`), render budgets.
- **`V86AppHarness`** (real tmux): anything whose bugs live in the real chain — command transport, control-mode parsing, reconcile timing, `%output` rendering. If a story asserts "tmux did X", it belongs here.

### Immediacy assertions (optimistic rendering)

"Immediate" is measured, not assumed: arm `armPaintProbe` (`stories/immediacy.ts`) just before the input, and assert the first matching DOM mutation lands within a few animation frames (≤5 absorbs userEvent dispatch overhead; a real round-trip takes dozens). A painted `__placeholder_*` pane id is itself proof of optimism — the server never emits one. After the optimistic paint, assert the reconcile is invisible: no pane-node removals (`LayoutMutationRecorder`), no highlight flaps (record the class/attribute history with a MutationObserver — polling misses one-frame reverts).

### Glitch budgets

`stories/glitchRecorder.ts` is the story-side counterpart of `tests/helpers/glitch-detector.js`: MutationObserver-based node-flicker/attribute-churn detection plus rAF rect sampling for size jumps. Budgets are code: both harnesses read `stories/glitch-thresholds.json` — loosening a budget is a reviewable diff, not a silent drift.

`stories/resizeGlitch.ts` (`ResizeGlitchRecorder`) is the resize-specific counterpart: it logs every pane's `top`/`left`/`width`/`height` — from both the inline-`style` MutationObserver (every React commit, so a 1-frame revert can't hide) and an rAF rect sampler — and flags any A→B→A *reversal*. A threshold-on-consecutive-frames detector misses these; a value that leaves and returns does not. It samples the outer box (top/left/width/height, via style + rAF) AND each pane's terminal-content top (`[role=log]`) — the content shifts a row when the header appears/disappears even while the box stays the same size. Because the resize stories drive a MONOTONIC drag, any reversal is a real glitch: a mid-drag grid shift, the pane flashing back to an old size after mouse-up, or an uninvolved pane's content jumping up a row. See `Scenarios/Application` → `ResizePaneDrag` (horizontal), `ResizePaneDragVertical` (stacked), `ResizePaneDragGrid` (2x2 tiled — a whole-band resize).

### Render budgets

`utils/renderLog.tsx` places `LogProfiler` markers inside key components; each marker records one entry per RENDER of its host component to `window.__tmuxyRenderLog` when a story enables it (`enableRenderLog()` before mount). Budgets assert render counts per component id (e.g. typing into pane A must not render `Pane:B` or `WindowTabs`). React's own `<Profiler onRender>` is deliberately not used — it over-reports in this tree, firing for subtrees that fully bailed out. MutationObserver cannot see this class of waste — a re-render that produces identical DOM still costs CPU.

## Unit Tests

- Use Vitest (configured in `packages/tmuxy-ui`)
- Test pure logic: parsers, state transformations, utility functions
- Do not test React component rendering in unit tests — that belongs in integration or E2E
- Keep unit tests fast (< 1s per file)

## Integration Tests

- Test interactions between two or more modules without the full system
- Example: XState machine + mock adapter, or parser + real tmux output
- Can use JSDOM for lightweight DOM assertions when visual correctness is not the concern

## Tauri Tests

- Tauri desktop app wraps the same React UI with native IPC instead of HTTP/SSE
- Test the IPC boundary: commands that go through `invoke()` and events that come through `listen()`
- Visual behavior tests should follow the same guidelines as E2E (verify visible, not just in DOM)

## What Not to Test

- Framework behavior (React renders components, XState transitions on events)
- CSS values in isolation (computed styles without visual verification)
- Internal state that has no user-visible consequence
- Implementation details that could change without affecting the user experience
- Third-party libraries doing what their docs say they do

## Running Tests

```bash
npm start               # Start dev server (required for E2E)
npm test                # Unit tests (Vitest)
npm run test:e2e        # E2E tests (Jest + Playwright CDP)

npm run storybook -w tmuxy-ui           # Storybook dev server (required for probes)
npm run test-storybook -w tmuxy-ui      # Probe all non-v86 stories
npm run test-storybook:v86 -w tmuxy-ui  # Probe v86 stories (shared engine)
```

## Debugging

```bash
# Single scenario by name
npm run test:e2e -- --testNamePattern="Scenario 22"

# Verbose output
npm run test:e2e -- --verbose

# Debug logging
DEBUG_TESTS=1 npm run test:e2e
```
