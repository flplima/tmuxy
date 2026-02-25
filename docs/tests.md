# Testing

End-to-end tests for the Tmuxy web-based tmux interface using Jest and Playwright.

## Overview

Tests verify the full integration between React UI, Rust backend, tmux, and the SSE/HTTP communication layer. They use real tmux sessions, real browser interactions, and real connections — no mocking or stubbing.

## Running Tests

```bash
# Start the dev server first
npm start

# Run all E2E tests
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
│   ├── assertions.js         # Custom assertions
│   ├── consistency.js        # UI↔tmux state consistency checks
│   ├── performance.js        # Performance measurement utilities
│   ├── glitch-detector.js    # MutationObserver harness for flicker detection
│   ├── mouse-capture.py      # Mouse event capture helper
│   ├── tmux.js               # Tmux command helpers
│   ├── config.js             # Test configuration
│   └── test-setup.js         # Jest setup/teardown
├── scenarios.test.js         # Primary E2E test suite (21 scenarios)
└── detailed/                 # Specialized tests
    ├── 11-osc-protocols.test.js    # OSC 8 hyperlinks, OSC 52 clipboard
    ├── 15-glitch-detection.test.js # Visual stability (flicker, attribute churn)
    └── 17-widgets.test.js          # Widget rendering (images, markdown)
```

## Test Suites

### scenarios.test.js (primary)

21 chained scenarios that each run multiple operations in a single session, minimizing setup/teardown overhead. This is the main test suite that covers all core functionality:

| Scenario | Coverage |
|----------|----------|
| 1. Connect & Render | Page load, SSE, ANSI colors, 256/truecolor, cursor, empty lines |
| 2. Keyboard Basics | Typing, backspace, Tab, Ctrl+C, Ctrl+D, arrow-up history |
| 3. Pane Lifecycle | Split H/V, navigate, resize, zoom/unzoom, kill, exit last |
| 4. Window Lifecycle | New window, tabs, next/prev, by-number, last, rename, close, layout |
| 5. Pane Groups | Header, add button, create group, switch tabs, add/close tab, content verify |
| 6. Floating Panes | Break-pane, float modal, header/close, tiled count, backdrop close |
| 7. Mouse Click & Scroll | Click terminal, scroll copy mode, user-select none, double-click |
| 8. Mouse Drag & SGR | Drag H/V divider, SGR click/wheel/right-click |
| 9. Copy Mode Navigate | Enter, hjkl, start/end line, page up/down, exit q/Escape |
| 10. Copy Mode Search & Yank | Set-buffer, paste, search, select, copy, repeat search n/N |
| 11. Status Bar | Bar visible, tabs, session name, active distinct, click tab, rename, close |
| 12. Session Reconnect | 2 panes, reload, verify preserved, split via tmux, rapid splits |
| 13. Multi-Client | 3 panes, page2, both see layout |
| 14. OSC Protocols | Hyperlink, multiple links, malformed, OSC 52 no crash |
| 15. Special Characters | ; # $ {} \ ~ quotes, diacritics, paste with specials |
| 16. Unicode Rendering | Box drawing, CJK, alignment, emoji single/multi, tree output |
| 17. Large Output Perf | yes\|head-500, seq 1 2000, scrollback, verify responsive |
| 18. Rapid Operations | Split x4, kill x3, split-close-split, 6 panes, 4 windows, swap |
| 19. Complex Workflow | 3 windows x splits, navigate all, send commands, verify alive |
| 20. Glitch Detection | Split H/V + detect, resize + detect, click focus + detect |
| 21. Touch Scrolling | CSS prevention, normal shell, alternate screen, multi-pane isolation |

### Specialized detailed tests

Tests with unique assertion types not covered by scenarios:

- **11-osc-protocols** — Focused OSC 8/52 sequence handling and edge cases
- **15-glitch-detection** — MutationObserver-based flicker detection with GlitchDetector API tests
- **17-widgets** — Image widget rendering, animation frames, widget detection edge cases

## Architecture

### Test Context

Each test uses a shared context object that manages browser and tmux lifecycle:

```javascript
const ctx = createTestContext();

beforeAll(ctx.beforeAll);   // Launch browser, check server
afterAll(ctx.afterAll);     // Close browser
beforeEach(ctx.beforeEach); // Create fresh tmux session
afterEach(ctx.afterEach);   // Kill tmux session
```

### TmuxTestSession

Wrapper class for tmux operations:

```javascript
ctx.session.splitHorizontal();        // Split pane
ctx.session.getPaneCount();           // Query state
ctx.session.sendKeys('"text" Enter'); // Send input
ctx.session.runCommand('list-panes'); // Run tmux command
```

### UI Helpers

```javascript
await runCommand(ctx.page, 'echo hello', 'hello');   // Type and verify
await waitForTerminalText(ctx.page, 'expected');      // Wait for content
await getUIPaneCount(ctx.page);                       // Query UI state
await assertStateConsistency(ctx.page, ctx.session);  // UI matches tmux
```

### Glitch Detection

Tests can detect visual instability using MutationObserver:

```javascript
const detector = new GlitchDetector(ctx.page);
await detector.start();
// ... operation ...
const result = await detector.stop();
console.log(GlitchDetector.formatTimeline(result));
```

Detection types:
- **Node flicker:** Element added then removed (or vice versa) within 100ms
- **Attribute churn:** Same attribute changing rapidly (>2x in 200ms)
- **Size jumps:** Pane dimensions changing >20px unexpectedly

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
