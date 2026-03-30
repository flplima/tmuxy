# Flicker Style — Visual Glitch Detection

Monitor the tmuxy UI for visual glitches during operations: flicker (DOM node churn), size jumps, attribute churn, and orphaned nodes.

## Setup

- Session name: `tmuxy-qa`
- Browser URL: `http://localhost:9000/?session=tmuxy-qa`
- Key helpers: `glitch-detector.js`, `layout.js`, `browser.js`, `keyboard.js`, `pane-ops.js`, `window-ops.js`

## How to Use GlitchDetector

```javascript
const detector = new GlitchDetector(page);
await detector.start();
// ... perform operation ...
const result = await detector.stop();
// result: { nodeFlickers, sizeJumps, attributeChurn, orphanedNodes }
await detector.assertNoGlitches(); // throws if glitches detected
```

## Evidence Format

For each failure, report:
- Scenario name
- `GlitchDetector.formatTimeline(result)` output
- Which glitch types were detected (nodeFlickers, sizeJumps, etc.)
- Operation that triggered the glitch

## After Each Scenario

Run `assertLayoutInvariants(page)` as a sanity check. If layout invariants fail, report that as an additional finding.

## Scenarios

### 1. Split Horizontal — Node Flickers
- Start with 1 pane
- `detector.start()` → `splitPaneKeyboard(page, 'horizontal')` → `waitForPaneCount(page, 2)` → `detector.stop()`
- Assert no node flickers or size jumps

### 2. Split Vertical — Node Flickers
- Same as above but `splitPaneKeyboard(page, 'vertical')`
- Assert no node flickers or size jumps

### 3. Kill Pane — Flicker During Removal
- Start with 2 panes
- `detector.start()` → `killPaneKeyboard(page)` → `waitForPaneCount(page, 1)` → `detector.stop()`
- Assert no flicker during pane removal

### 4. Resize Pane — Size Jumps
- Start with 2 panes
- `detector.start()` → `resizePaneKeyboard(page, 'down', 5)` → wait → `detector.stop()`
- Assert no unexpected size jumps beyond the resize itself

### 5. Window Switch — Attribute Churn
- Create 2 windows
- `detector.start()` → `nextWindowKeyboard(page)` → wait → `detector.stop()`
- Assert minimal attribute churn during switch

### 6. Group Tab Switch — Node Flickers
- Create a pane group with 2 tabs
- `detector.start()` → switch group tabs → `detector.stop()`
- Assert no node flickers during pane swap

### 7. Zoom Toggle — Size Jumps
- Start with 2 panes
- `detector.start()` → `toggleZoomKeyboard(page)` (zoom in) → wait → `toggleZoomKeyboard(page)` (zoom out) → `detector.stop()`
- Assert no unexpected size jumps

### 8. Rapid 5-Split Spam
- `detector.start()` → split 5 times rapidly → wait for 6 panes → `detector.stop()`
- Stress test: assert cumulative glitch count within threshold

### 9. Drag Pane Header — Attribute Churn
- Start with 2 panes
- `detector.start()` → simulate pane header drag (mousedown, mousemove, mouseup) → `detector.stop()`
- Assert attribute churn stays within limits

### 10. Float Open/Close — Orphaned Nodes
- `detector.start()` → open float (`tmuxy pane float`) → wait → close float → `detector.stop()`
- Assert no orphaned DOM nodes remain

### 11. Layout Cycle — All 5 Layouts
- Start with 3 panes
- `detector.start()` → `cycleLayoutKeyboard(page)` x5 → `detector.stop()`
- Assert clean transitions without glitches

### 12. Window Create+Switch+Kill Rapid Cycle
- `detector.start()` → create window → switch → switch back → kill → `detector.stop()`
- Assert compound operation stability
