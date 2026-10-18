# Testing

How tmuxy is tested today, where a new test belongs, and the rules every test follows. The first half is the map (layers, CI, gaps); the second half is the guidelines per layer.

See [TESTS-LAYERS.md](TESTS-LAYERS.md) for these sections: The Test Layers; Which Layer Does a New Test Go In?; Tiers: per commit, nightly, and before a release; UI Unit Tests; Rust Tests; CLI Tests.

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

## Does This Test Earn Its Place?

Three questions for a new test, and for any test you touch; a "yes" to any one of them is a test to delete or fold into its neighbour. Sixty cases went in one pass once these were asked, and none had ever caught a tmuxy bug.

1. **Could it fail only if a dependency changed?** A test of `thiserror`'s `Display`, of `vt100` measuring an emoji, of Effect's `catchTags`, of a derived `Default` — tests the library, not the product.
2. **Is there another test in the file that fails for the same reason?** Every `-h` row beside its `--help` row; six copy-pasted direction tests that differ in one string; a "renders the container" test before a test that renders the container and then checks its contents. Tables and `test.each` are for the rows that differ in data, not for repeating a row.
3. **Does it assert something the code never does?** A hook that never sends an event, asserted not to send it; a store rejection whose error type is never checked; a test helper tested instead of the thing it stands in for. These pass forever and say nothing.

The matching rule for waits: a wait names the **event** it expects, never a count of events or a state derived from one. A count is satisfied by a late report of the previous event; an optimistic client state is set before anything happened; tmux's current pane during a group swap is whichever window the swap is passing through. Where no settled signal exists, a fixed wait with a comment saying why is the honest choice, and `BLIND_WAIT_CEILING` in `bin/check-repo-policy.mjs` exists to make it explicit, not to be ratcheted to zero.

## Assertions That Catch Real Bugs

For every assertion, ask: **"What bug would make this assertion fail?"** If you cannot name a specific, plausible bug, the assertion is not useful.

| Assertion | Bug it catches |
| --- | --- |
| Float container bounding rect > 100x100 | Overflow clipping, zero-height parent, missing content |
| Typed text appears within the visible area of the float | Keyboard routing broken, content not rendering, wrong pane targeted |
| Float is gone after close AND no orphan tmux window | Close handler broken, tmux window leak |
| Background pane still interactive after float closes | Focus not restored, keyboard routing stuck |

| Assertion | What it does NOT catch |
| --- | --- |
| `getComputedStyle(fc).borderColor === green` | Border on invisible element |
| `log.textContent.includes(token)` | Text in DOM but clipped/hidden |
| `floatPanes.length === 1` | Float exists in state but not rendered |
| `focusedFloatPaneId !== null` | Focus set but keyboard not actually routing |

See [TESTS-E2E.md](TESTS-E2E.md) for these sections: E2E Tests; Interaction-Latency Tests; Desktop (Tauri) Tests; Debugging.

See [TESTS-STORYBOOK.md](TESTS-STORYBOOK.md) for this section: Storybook Tests.

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

## Known Gaps

| Gap | Evidence |
| --- | --- |
| No check is required to merge | `main` has no branch protection; its ruleset only blocks deletion and force-push. A red `lint-and-tests` run does not stop a merge. |
| The packaged macOS app is only tested after merge | The Linux desktop smoke test runs on PRs (`desktop` in `lint-and-tests.yml`), but `build-app.yml` — which builds the macOS app and runs the sparse-PATH test — triggers only on tags, a daily cron and manual dispatch. Dispatch it before tagging when a change touches the desktop app or packaging. |
| macOS WKWebView gets no functional desktop suite | `tests/tauri/` is Linux-only (`tests/tauri/helpers/xvfb.js`, `tests/tauri/helpers/tauri-driver.js`); macOS only gets `tests/smoke/smoke-test.js`, post-merge. |
| Output flood tests are light | The heaviest is `tests/5-stress-stability.test.js` Scenario 17: `yes \| head -500` and `seq 1 2000`. No sustained, multi-megabyte or backpressure test exists, and the latency gate measures no output throughput. |
| Uncovered crates and scripts | `packages/tmuxy-demo` has no tests and `deploy-demo.yml` deploys without testing. |
| `deltaProtocol.ts` is largely untested in substance | A one-off Stryker run scored it at 24.96% (285 surviving mutants, 175 lines with no coverage) despite unit and property tests existing for it; most survivors were the conditional-spread guards the property tests exercise without asserting on. |
| Clippy is not run over test code | CI runs `cargo clippy` without `--tests`, so lints in `#[cfg(test)]` modules and `tests/` go unchecked — `packages/tmuxy-core/tests/control_mode_push_api.rs` is missing the `allow` attribute every sibling has and would fail today. |

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — the components each test tier covers
- [PERFORMANCE.md](PERFORMANCE.md) — the benchmark and probe harnesses that share this infrastructure
- [COPY-MODE.md](COPY-MODE.md) — how to drive copy mode from a test through real user input
- [TMUX.md](TMUX.md) — the control-mode constraints test sessions must respect
- [INVARIANTS.md](INVARIANTS.md) — the cross-layer promises and which test enforces each; the `—` cells are where a new property test belongs
