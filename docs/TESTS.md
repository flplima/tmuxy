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

- Tests connect to Chrome via CDP on port 9222 (never install Playwright browsers)
- All E2E tests run sequentially (`maxWorkers: 1`) — they share one tmux server
- Dev server must be running (`npm start`)

### Session Lifecycle

- Each `describe` block gets its own tmux session via `createTestContext()`
- Call `destroyViaAdapter()` before closing the browser page
- Never leave tmux sessions or windows behind — cleanup in `afterAll`

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
