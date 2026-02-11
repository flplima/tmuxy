# Tmuxy E2E Test Suite

End-to-end tests for the Tmuxy web-based tmux interface using Jest and Playwright.

## Overview

This test suite verifies the integration between:
- **React UI** (Vite frontend)
- **Rust backend** (Axum web server)
- **tmux** (terminal multiplexer)
- **WebSocket** communication layer

Tests use real tmux sessions, real browser interactions, and real WebSocket connections. There is no mocking or stubbing.

## Running Tests

```bash
# Start the dev server first
npm run web:dev:start

# Run all E2E tests
npm run test:e2e

# Run specific test file
npm run test:e2e -- --testPathPattern="01-basic-connectivity"

# Run with debug output
DEBUG_TESTS=1 npm run test:e2e
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
│   └── test-setup.js         # Jest setup/teardown
├── 01-basic-connectivity.test.js   # Smoke tests, rendering
├── 02-keyboard-input.test.js       # Keyboard handling
├── 03-pane-operations.test.js      # Split, navigate, resize
├── 04-window-operations.test.js    # Window management
├── 05-pane-groups.test.js          # Pane UI structure
├── 06-floating-panes.test.js       # Float pane feature
├── 07-mouse-events.test.js         # Mouse interactions
├── 08-copy-mode.test.js            # Tmux copy mode
├── 09-status-bar.test.js           # Status bar UI
├── 10-session-connection.test.js   # WebSocket, reconnection
├── 11-osc-protocols.test.js        # OSC 8, OSC 52 sequences
├── 12-popup-support.test.js        # Tmux popup (stability only)
├── 13-performance.test.js          # Stress tests
├── 14-workflows.test.js            # Real-world scenarios
└── README.md                       # This file
```

## Test Categories

| Category | Tests | Description |
|----------|-------|-------------|
| 01 - Basic Connectivity | 27 | Page load, WebSocket, terminal rendering, ANSI colors |
| 02 - Keyboard Input | 25 | Key handling, modifiers, special keys, shortcuts |
| 03 - Pane Operations | 16 | Split, navigate, resize, close, zoom, swap |
| 04 - Window Operations | 15 | Create, navigate, rename, close, layouts |
| 05 - Pane UI Structure | 11 | Headers, active styling, close buttons |
| 06 - Floating Panes | 11 | Convert to float, move, pin, embed |
| 07 - Mouse Events | 14 | Click focus, scroll, selection, resize drag |
| 08 - Copy Mode | 17 | Enter/exit, navigation, selection, paste, search |
| 09 - Status Bar | 16 | Rendering, tabs, menu, interactions |
| 10 - Session Connection | 12 | Persistence, reconnection, multi-client |
| 11 - OSC Protocols | 6 | Hyperlinks (OSC 8), clipboard (OSC 52) |
| 12 - Popup Support | 5 | Stability tests only (feature blocked) |
| 13 - Performance | 8 | Rapid output, many panes, stress tests |
| 14 - Workflows | 10 | Real-world usage scenarios |

**Total: 197 tests**

## Architecture

### Test Context

Each test file uses a shared context object:

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
await runCommand(ctx.page, 'echo hello', 'hello');  // Type and verify
await waitForTerminalText(ctx.page, 'expected');    // Wait for content
await getUIPaneCount(ctx.page);                     // Query UI state
await assertStateConsistency(ctx.page, ctx.session); // UI matches tmux
```

## Known Limitations

### 1. Synthetic Events for Floating Panes

Floating pane tests use direct state machine events because UI controls don't exist yet:

```javascript
await page.evaluate((paneId) => {
  window.app.send({ type: 'CONVERT_TO_FLOAT', paneId });
}, paneId);
```

**Tracking:** Placeholder tests exist for when UI is implemented.

### 2. OSC 8 Hyperlinks (Text Only)

Hyperlinks render as text but are not clickable. The terminal handles OSC 8 sequences without crashing, but link functionality is not implemented.

**Status:** Feature enhancement, not a bug.

### 3. Popup Support (Blocked Upstream)

Tmux popup support requires control mode popup support from tmux PR #4361. Tests verify stability only - that popup commands don't crash the session.

**Status:** Blocked on upstream tmux changes.

### 4. IME Input

Input Method Editor (IME) testing requires platform-specific APIs not available in headless Chrome. Only basic text input is tested.

**Status:** Requires manual testing for CJK input methods.

### 5. Mouse Selection Behavior

Text selection behavior varies by terminal implementation. Tests accept either browser selection OR tmux copy mode as valid outcomes.

**Status:** Acceptable variation in implementation.

## Test Patterns

### Graceful Degradation

All tests use conditional skipping when infrastructure is unavailable:

```javascript
test('Test name', async () => {
  if (ctx.skipIfNotReady()) return;
  // ... test code
});
```

This allows partial test runs and CI flexibility.

### State Consistency

Tests verify UI state matches tmux state:

```javascript
await assertStateConsistency(ctx.page, ctx.session);
```

This catches synchronization bugs between frontend and backend.

### Real Interactions

Tests use real browser interactions, not synthetic events:

```javascript
// Good - real keyboard
await ctx.page.keyboard.press('Enter');

// Good - real mouse
await ctx.page.mouse.click(x, y);

// Avoid - synthetic events (except where documented)
await page.evaluate(() => element.click());
```

## Debugging

### View Test Output

```bash
# Run with verbose logging
npm run test:e2e -- --verbose

# Run single test with debug
DEBUG_TESTS=1 npm run test:e2e -- --testNamePattern="Page loads"
```

### Inspect Failures

Tests capture terminal state on failure:

```javascript
const text = await getTerminalText(ctx.page);
console.log('Terminal content:', text);

const tmuxState = ctx.session.runCommand('list-panes -F "#{pane_id}"');
console.log('Tmux state:', tmuxState);
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Tests timeout | Server not running | Run `npm run web:dev:start` |
| Session not found | Tmux not installed | Install tmux 3.2+ |
| Element not found | UI changed | Update selectors |
| Flaky assertions | Timing issues | Increase `DELAYS` constants |

## Contributing

### Adding New Tests

1. Choose appropriate category file (or create new one)
2. Follow existing patterns for setup/teardown
3. Use helpers from `./helpers/`
4. Verify both UI and tmux state
5. Document any limitations

### Test Quality Checklist

- [ ] Uses real interactions (keyboard, mouse)
- [ ] Verifies actual behavior, not just element existence
- [ ] Checks state consistency between UI and tmux
- [ ] Handles timing with appropriate delays
- [ ] Cleans up resources (copy mode, extra panes)
- [ ] Documents any limitations or workarounds

## Risks

### Flakiness Sources

1. **Timing:** Terminal output speed varies. Use `waitForTerminalText()` instead of fixed delays.
2. **State pollution:** Tests must clean up copy mode, extra panes. Use fresh session per test.
3. **Resource limits:** Too many concurrent tests can exhaust tmux sessions or browser memory.

### Not Covered

- Visual regression (pixel-perfect rendering)
- Accessibility (screen reader compatibility)
- Mobile/touch interactions
- Multiple monitor configurations
- Network latency simulation

## Opportunities

### Future Improvements

1. **Visual regression tests** - Screenshot comparison for styling
2. **Accessibility tests** - ARIA attributes, keyboard navigation
3. **Performance benchmarks** - Track render times, memory usage
4. **Cross-browser testing** - Firefox, Safari support
5. **Load testing** - Many concurrent sessions

### When Features Complete

- **Floating panes:** Replace synthetic events with UI interactions
- **Popup support:** Add full feature tests when tmux PR merges
- **OSC 8 links:** Add click-to-open tests when implemented
