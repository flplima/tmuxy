# Performance Style — Latency and Memory Regression Detection

Measure operation latency and detect performance regressions against stored baselines.

## Setup

- Session name: `tmuxy-qa`
- Browser URL: `http://localhost:9000/?session=tmuxy-qa`
- Key helpers: `performance.js`, `browser.js`, `keyboard.js`, `pane-ops.js`, `window-ops.js`, `pane-groups.js`, `consistency.js`
- Baseline file: `.claude/baselines/performance.json`

## Thresholds

| Operation | Max Acceptable | Regression = Bug |
|-----------|---------------|-----------------|
| Keyboard round-trip | 500ms | >50% above baseline |
| Split pane | 1000ms | >50% above baseline |
| Kill pane | 500ms | >50% above baseline |
| Window create | 1500ms | >50% above baseline |
| Window switch | 500ms | >50% above baseline |
| Layout cycle (each) | 300ms | >50% above baseline |
| 100-char typing | 5000ms | >50% above baseline |
| Float open/close | 800ms | >50% above baseline |
| Group tab switch | 500ms | >50% above baseline |

Take 3 measurements for each operation, use the median to handle outliers.

## Evidence Format

For each failure, report:
- Scenario name
- Measured time (median of 3)
- Baseline value
- Regression percentage
- Threshold exceeded

## Scenarios

### 1. Keyboard Round-Trip
- `measureKeyboardRoundTrip(page, 'echo test_' + randomId)`
- `assertCompletesWithin(fn, 500, 'keyboard round-trip')`

### 2. Split Pane Latency
- Measure: `splitPaneKeyboard(page, 'horizontal')` → `waitForPaneCount(page, 2)`
- `assertCompletesWithin(fn, 1000, 'split pane')`

### 3. Kill Pane Latency
- Start with 2 panes
- Measure: `killPaneKeyboard(page)` → `waitForPaneCount(page, 1)`
- `assertCompletesWithin(fn, 500, 'kill pane')`

### 4. Window Create Latency
- Measure: `createWindowKeyboard(page)` → `waitForWindowCount(page, 2)`
- `assertCompletesWithin(fn, 1500, 'window create')`

### 5. Window Switch Latency
- Create 2 windows
- Measure: `nextWindowKeyboard(page)` → content update
- `assertCompletesWithin(fn, 500, 'window switch')`

### 6. Layout Cycle Latency
- Create 3 panes
- For each of 5 cycles: measure `cycleLayoutKeyboard(page)`
- `assertCompletesWithin(fn, 300, 'layout cycle')`

### 7. Rapid 100-Character Typing
- Generate 100-char string
- Measure: type + Enter + `waitForTerminalText`
- Verify all chars arrived

### 8. Memory After 20 Split+Kill Cycles
- Record initial `performance.memory?.usedJSHeapSize`
- Repeat 20 times: split, wait, kill, wait
- Record final heap size
- Flag if >50% growth

### 9. SSE Reconnection Time
- Navigate away from session
- Navigate back
- Measure time until state fully restored

### 10. Float Open/Close 10x
- 10 cycles: open float, wait, close
- Measure cumulative time
- Check for degradation: last iteration should not be >2x slower than first

### 11. Group Tab Switch Latency
- Create group with 5 tabs
- Measure each `clickGroupTab(page, index)` switch
- Each within 500ms

### 12. Baseline Management
- After all measurements, compare current vs stored baselines
- Report any >50% regressions as failures
- Update `.claude/baselines/performance.json` with latest measurements
