# Snapshot Style — UI vs Tmux State Drift

Detect state drift: cases where the browser UI shows something different from what tmux actually has.

## Setup

- Session name: `tmuxy-qa`
- Browser URL: `http://localhost:9000/?session=tmuxy-qa`
- Key helpers: `snapshot-compare.js`, `consistency.js`, `layout.js`, `browser.js`, `keyboard.js`, `pane-ops.js`, `window-ops.js`

## Evidence Format

For each failure, report:
- Scenario name
- `compareSnapshots(ui, tmux)` output showing mismatches
- Pane/window counts from both UI and tmux
- Active pane/window IDs from both states

## Scenarios

### 1. Single Pane Baseline
- Fresh session with one pane
- `extractUIState(page)` and `extractTmuxState('tmuxy-qa')`
- `compareSnapshots(ui, tmux)` — expect 0 mismatches
- Verify pane count, window count, active pane ID all match

### 2. Split Horizontal
- `sendPrefixCommand(page, '"')` to split horizontally
- `waitForPaneCount(page, 2)`
- Compare snapshots — verify 2 panes in both states
- Check pane positions and dimensions are consistent

### 3. Split Vertical
- `sendPrefixCommand(page, '%')` to split vertically
- `waitForPaneCount(page, 2)`
- Compare snapshots — verify pane orientations match

### 4. Kill Pane
- Start with 2 panes (split first)
- `sendPrefixCommand(page, 'x')` then confirm with `y`
- `waitForPaneCount(page, 1)`
- Compare snapshots — verify remaining pane resized to fill space

### 5. Create Second Window
- `createWindowKeyboard(page)` (uses split-window + break-pane)
- `waitForWindowCount(page, 2)`
- Compare snapshots — verify window list has 2 entries in both states

### 6. Switch Windows
- With 2 windows, `nextWindowKeyboard(page)`
- Wait for UI to update
- Compare snapshots — verify `activeWindowId` changed in both states

### 7. Create Float
- Type `tmuxy pane float` + Enter in the terminal
- Wait for float pane to appear in UI
- Compare snapshots — verify float pane exists in both states

### 8. Close Float
- After creating a float, close it
- Compare snapshots — verify float removed from both states

### 9. Create Pane Group
- Type `tmuxy pane group add` + Enter
- Wait for group tabs to appear
- Compare snapshots — verify group membership in state

### 10. Switch Group Tabs
- With a group of 2+ panes, switch tabs
- Compare snapshots — verify active tab matches in both states

### 11. Rename Window
- `renameWindowKeyboard(page, 'test-rename')`
- Compare snapshots — verify window name is `test-rename` in both states

### 12. Rapid Split+Kill Cycle
- Split 3 times (creating 4 panes)
- Kill 2 panes
- Compare snapshots — verify final 2-pane state matches

### 13. Multi-Window Full Comparison
- Create 2 windows, split panes in each (3 panes in window 1, 2 in window 2)
- Run full `compareSnapshots` — verify all comparison checks pass
- Run `assertLayoutInvariants(page)` as additional validation
