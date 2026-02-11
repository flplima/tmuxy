# Tmuxy Performance Analysis Report

## Executive Summary

Performance testing reveals that while individual operations are fast (50-500ms), significant overhead exists in:
1. **Test infrastructure** (~3-4s per test for setup)
2. **Fixed synchronization delays** (cumulative 2-4s per workflow)
3. **Terminal rendering** (per-character processing in TerminalLine)

The application itself has good performance characteristics with proper optimizations in place.

---

## 1. Test Timing Analysis

| Test Category | Tests | Avg Overhead | Overhead % |
|---------------|-------|--------------|------------|
| Keyboard Input | 3 | 3,733ms | 71% |
| Mouse Events | 3 | 3,691ms | 88% |
| Workflows | 4 | 2,132ms | 27% |

### Key Finding
Tests spend 27-88% of their time in overhead (setup, delays, synchronization), not actual operation measurement.

---

## 2. Identified Performance Issues

### HIGH SEVERITY

#### 2.1 Test Setup Overhead (~3-4s per test)
**Location:** `tests/helpers/test-setup.js`, `tests/helpers/browser.js`

Each test incurs:
- Page navigation with retries (up to 3 attempts)
- Terminal content wait with polling
- WebSocket connection establishment
- Session ready verification

**Evidence:** Mouse click test has 500ms threshold but 3,754ms total time (3,254ms overhead)

**Recommendation:** Consider test batching or session reuse between related tests.

---

#### 2.2 Hardcoded Synchronization Delays
**Location:** `tests/helpers/config.js`

```javascript
DELAYS = {
  SHORT: 100ms,
  MEDIUM: 300ms,
  LONG: 500ms,
  EXTRA_LONG: 1000ms,
  SYNC: 2000ms,      // ← Most impactful
  PREFIX: 600ms,     // ← Tmux prefix wait
}
```

These delays are used liberally in UI helpers:
- `splitPaneKeyboard()` adds 1000ms after split
- `createWindowKeyboard()` adds 1000ms after creation
- `sendPrefixCommand()` waits 600ms + 500ms

**Evidence:** Tab workflow (3 windows) includes 3×500ms + 2000ms = 3500ms of fixed delays

**Recommendation:** Replace fixed delays with event-driven waits where possible.

---

### MEDIUM SEVERITY

#### 2.3 Prefix Key Timing (600ms wait)
**Location:** `tests/helpers/ui.js:61`

```javascript
async function sendTmuxPrefix(page) {
  // ...
  await delay(DELAYS.PREFIX); // 600ms wait
}
```

After sending tmux prefix (Ctrl+A), we wait 600ms before the next key. This is conservative.

**Evidence:** Prefix sequence test measures 1,064ms for a simple Ctrl+A, c operation.

**Recommendation:** Investigate reducing to 200-300ms based on actual tmux response time.

---

#### 2.4 Per-Character Typing Delay (30ms)
**Location:** `tests/helpers/ui.js:132-135`

```javascript
async function typeInTerminal(page, text) {
  for (const char of text) {
    await page.keyboard.type(char);
    await delay(30);  // 30ms per character
  }
}
```

For 50 characters, this adds 1,500ms of delay.

**Evidence:** Rapid typing test measures 2,282ms for a command that could be sent in <100ms.

**Recommendation:** Use `page.keyboard.type(text, { delay: 0 })` for bulk input.

---

#### 2.5 Split Pane EXTRA_LONG Delay (1000ms)
**Location:** `tests/helpers/ui.js:377`

```javascript
async function splitPaneKeyboard(page, direction) {
  // ...
  await delay(DELAYS.EXTRA_LONG); // 1000ms
}
```

Every split operation adds 1 second of delay, even when followed by `waitForPaneCount()`.

**Evidence:** Multi-pane workflow: 3 splits × 1000ms = 3000ms of pure delay.

**Recommendation:** Remove delay when followed by explicit wait function.

---

### LOW SEVERITY

#### 2.6 JSON.stringify in Render Loop
**Location:** `packages/tmuxy-ui/src/components/TerminalLine.tsx:206`

```javascript
const cellStyleKey = cell.s ? JSON.stringify(cell.s) : '';
```

Called for every cell on every render. For a 80×24 terminal, this is 1,920 stringify calls per render.

**Current Mitigation:** Component is memoized with custom comparison.

**Recommendation:** Consider style hashing or reference comparison instead.

---

#### 2.7 RAF Debouncing Already Implemented
**Location:** `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts:22-38`

```javascript
const flushStateUpdate = () => {
  rafId = null;
  if (pendingState) {
    input.parent.send({ type: 'TMUX_STATE_UPDATE', state: pendingState });
    pendingState = null;
  }
};
```

State updates are already batched to one per animation frame - this is good.

---

#### 2.8 Keystroke Batching Already Implemented
**Location:** `packages/tmuxy-ui/src/tmux/adapters.ts:62,243-263`

```javascript
const KEY_BATCH_INTERVAL_MS = 16; // ~1 frame

// In invoke():
if (!this.keyBatchTimeout) {
  this.keyBatchTimeout = setTimeout(() => this.flushKeyBatch(), KEY_BATCH_INTERVAL_MS);
}
```

Keystrokes are already batched every 16ms - this is good for reducing WebSocket messages.

---

## 3. Latency Estimates

Based on test measurements:

| Operation | Estimated Latency | Notes |
|-----------|-------------------|-------|
| Single keystroke round-trip | 50-100ms | Browser → WS → Rust → tmux → Rust → WS → Browser |
| Prefix sequence | 100-200ms | Two round-trips |
| Mouse event | 50-100ms | Single round-trip |
| State sync after operation | 500-1000ms | Includes tmux processing + delta calculation |
| Full terminal render | 5-20ms | Memoized, only changed lines re-render |

---

## 4. Application Architecture Review

### Positive Patterns

1. **Delta Protocol**: State updates use deltas, not full state
2. **RAF Debouncing**: State updates batched per frame
3. **Keystroke Batching**: Multiple keys combined into single WebSocket message
4. **Memoized Components**: TerminalLine uses `memo()` with custom comparison
5. **Line-level Updates**: Only changed lines re-render

### Areas for Improvement

1. **Style Comparison**: `JSON.stringify()` in hot path
2. **Test Infrastructure**: High setup overhead
3. **Fixed Delays**: Could be event-driven

---

## 5. Recommendations Summary

### Quick Wins (Test Infrastructure)

| Change | Impact | Effort |
|--------|--------|--------|
| Use `keyboard.type(text, {delay: 0})` | -1.5s on typing tests | Low |
| Reduce PREFIX delay to 300ms | -300ms per prefix | Low |
| Remove redundant EXTRA_LONG delays | -1s per split/window | Low |

### Medium-term Improvements

| Change | Impact | Effort |
|--------|--------|--------|
| Event-driven waits instead of fixed delays | -50% test time | Medium |
| Style comparison optimization | -5% render time | Medium |
| Test session reuse | -3s per test | Medium |

### Long-term Considerations

| Change | Impact | Effort |
|--------|--------|--------|
| Virtual scrolling for large outputs | Memory reduction | High |
| WebWorker for ANSI parsing | Smoother rendering | High |
| Binary WebSocket protocol | -30% message size | High |

---

## 6. Conclusion

The Tmuxy application has good performance characteristics:
- Keystroke batching (16ms intervals)
- State update debouncing (RAF)
- Delta protocol for state updates
- Memoized terminal rendering

Most measured "slowness" is from test infrastructure, not the application itself. The recommended quick wins can reduce test execution time by 30-50% without changing application code.
