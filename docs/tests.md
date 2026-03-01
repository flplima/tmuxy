# Testing

End-to-end tests for the Tmuxy web-based tmux interface using Jest and Playwright.

## Overview

Tests verify the full integration between React UI, Rust backend, tmux, and the SSE/HTTP communication layer. They use real tmux sessions, real browser interactions, and real connections — no mocking or stubbing.

## Running Tests

```bash
# Start the dev server first
npm start

# Run all E2E tests (sequential via --runInBand, maxWorkers: 1)
npm run test:e2e

# Run with debug output
DEBUG_TESTS=1 npm run test:e2e

# Unit tests (Vitest)
npm test
```

## Test Structure

```
tests/
├── helpers/
│   ├── index.js              # Main exports and utilities
│   ├── TmuxTestSession.js    # Tmux session wrapper class
│   ├── browser.js            # Browser/Playwright utilities
│   ├── ui.js                 # UI interaction helpers
│   ├── consistency.js        # UI↔tmux state consistency checks
│   ├── glitch-detector.js    # MutationObserver harness for flicker detection
│   ├── mouse-capture.py      # Mouse event capture helper
│   ├── config.js             # Test configuration
│   └── test-setup.js         # Context factory, snapshot comparison
├── 1-input-interaction.test.js    # Scenarios 2, 7, 8, 9, 10, 21
├── 2-layout-navigation.test.js   # Scenarios 4, 5, 6, 11
├── 3-rendering-protocols.test.js  # Scenarios 14, 16, widgets
├── 4-session-connectivity.test.js # Scenarios 12, 13
└── 5-stress-stability.test.js     # Scenarios 17, 18, 19, 20
```

## Test Suites

### Test Suites

18 scenarios organized across 5 thematic test files. Each file creates isolated tmux sessions per `describe` block:

| File | Scenarios | Coverage |
|------|-----------|----------|
| `1-input-interaction` | 2, 7, 8, 9, 10, 21 | Keyboard, mouse click/scroll, mouse drag/SGR, copy mode, touch |
| `2-layout-navigation` | 4, 5, 6, 11 | Window lifecycle, pane groups, floating panes, status bar |
| `3-rendering-protocols` | 14, 16, widgets | OSC 8/52, unicode, box drawing, image/markdown widgets |
| `4-session-connectivity` | 12, 13 | Session reconnect, multi-client |
| `5-stress-stability` | 17, 18, 19, 20 | Large output perf, rapid operations, complex workflow, glitch detection |

## Architecture

### Test Context

Each `describe` block uses `createTestContext()` from `tests/helpers/test-setup.js`. It provides lifecycle hooks (`beforeAll`/`afterAll`/`beforeEach`/`afterEach`) that manage browser launch, server checks, tmux session creation, and cleanup. Access the browser page via `ctx.page` and the tmux session via `ctx.session`.

### TmuxTestSession

Wrapper class (in `tests/helpers/TmuxTestSession.js`) for tmux operations. Key methods: `splitHorizontal()`, `getPaneCount()`, `sendKeys()`, `_exec()` (route commands through the adapter when a browser page is connected).

### UI Helpers

Key helpers from `tests/helpers/ui.js` and `tests/helpers/consistency.js`:
- `runCommand(page, cmd, expected)` — Type command and wait for expected output
- `waitForTerminalText(page, text)` — Wait for text to appear in terminal
- `getUIPaneCount(page)` — Query pane count from XState context
- `assertStateMatches(page)` — Verify UI state matches tmux (Levenshtein distance)

### Glitch Detection

Tests can detect visual instability using `GlitchDetector` from `tests/helpers/glitch-detector.js`. It injects a MutationObserver into the browser to catch: node flicker (added+removed within 100ms), attribute churn (>2 changes in 200ms), and size jumps (>20px unexpectedly). Enable via `createTestContext({ glitchDetection: true })` or use the detector directly.

## Rules

1. **No skipped tests.** Never commit `it.skip`, `test.skip`, `describe.skip`, `xit`, `xtest`, or `xdescribe`. ESLint enforces this via `jest/no-disabled-tests` (error). Fix the test, fix the bug, or remove the test.
2. **Real interactions.** Use real browser interactions (keyboard, mouse), not synthetic events, unless documented otherwise.
3. **State consistency.** Verify UI state matches tmux state where applicable.
4. **Sequential execution.** All tests share one tmux server and run sequentially (`maxWorkers: 1`).
5. **Session cleanup.** Call `destroyViaAdapter()` before closing the browser page to route through control mode.

## Debugging

```bash
# Verbose logging
npm run test:e2e -- --verbose

# Single test by name
npm run test:e2e -- --testNamePattern="Scenario 3"

# Debug output
DEBUG_TESTS=1 npm run test:e2e
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Tests timeout | Server not running | Run `npm start` |
| Session not found | Tmux not installed | Install tmux 3.2+ |
| Element not found | UI selectors changed | Update selectors |
| Flaky assertions | Timing issues | Increase `DELAYS` constants |

## Known Limitations

- **OSC 8 hyperlinks** render as text but are not clickable (feature enhancement)
- **IME input** requires platform-specific APIs not available in headless Chrome (manual testing only)
- **Visual regression**, accessibility, and cross-browser testing are not covered
