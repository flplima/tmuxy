# Input Style — Keyboard and Mouse Interaction Testing

Test all input interactions: keyboard (typing, prefix commands, copy mode, special characters) and mouse (clicks, drags, scrolls, SGR protocol, border resize).

## Setup

- Session name: `tmuxy-qa`
- Browser URL: `http://localhost:9000/?session=tmuxy-qa`
- Key helpers: `keyboard.js`, `mouse-capture.js`, `pane-ops.js`, `window-ops.js`, `copy-mode.js`, `copy-mode-ui.js`, `browser.js`, `consistency.js`, `layout.js`

## Important Notes

- Copy mode is a **client-side reimplementation** — test via browser keyboard events and `getCopyModeState()`, not tmux `send-keys -X` commands.
- Always `focusTerminal(page)` before sending keys.
- Prefix key is Ctrl+b. Use `sendPrefixCommand(page, key)` which handles it automatically.
- When reading mouse events, always `trim()` lines.
- Don't restart mouse capture script mid-test — start once, search all events.
- SGR mouse coordinates are 1-based. Use `expectedSgrCoord()` to calculate expected values.

## Evidence Format

For each failure, report:
- Scenario name (K1-K13 or M1-M12)
- Key/mouse events sent
- Expected vs actual behavior
- State diffs if applicable

## Keyboard Scenarios

### K1. Basic Typing — Echo Test
- `focusTerminal(page)` → `typeInTerminal(page, 'echo hello_world')` → `pressEnter(page)`
- `waitForTerminalText(page, 'hello_world')` — verify output appears

### K2. Prefix + `"` — Split Horizontal
- `sendPrefixCommand(page, '"')` → `waitForPaneCount(page, 2)`
- Verify 2 panes visible via `getUIPaneCount(page)`

### K3. Prefix + `%` — Split Vertical
- `sendPrefixCommand(page, '%')` → `waitForPaneCount(page, 2)`

### K4. Ctrl+Arrow Navigation (4 Panes)
- Create 4 panes (split h, select first, split v, select third, split v)
- Navigate up/down/left/right with `navigatePaneKeyboard(page, direction)`
- Check `assertStateMatches(page)` after each navigation

### K5. Prefix + `z` — Zoom Toggle
- Start with 2 panes
- `toggleZoomKeyboard(page)` — verify pane is zoomed (fills viewport)
- `toggleZoomKeyboard(page)` — verify both panes visible again

### K6. Prefix + `o` — Next Pane Cycle
- Create 3 panes
- `sendPrefixCommand(page, 'o')` repeatedly — verify all 3 panes visited in order

### K7. Prefix + `n`/`p` — Window Switching
- Create 2 windows
- `nextWindowKeyboard(page)` → verify switched
- `prevWindowKeyboard(page)` → verify switched back

### K8. Copy Mode — Enter, Navigate, Exit
- `enterCopyModeKeyboard(page)` → `waitForCopyMode(page, true)`
- Send h/j/k/l for navigation, check cursor position via `getCopyModeState(page)`
- `exitCopyModeKeyboard(page)` → `waitForCopyMode(page, false)`

### K9. Copy Mode — Selection and Yank
- Generate text: `typeInTerminal(page, 'echo SELECTME')` + Enter
- Enter copy mode, navigate to word, Space to select, move, Enter to yank
- Verify selection was captured

### K10. Input Isolation Between Panes
- Create 2 panes
- Type `echo PANE1` in pane 1, verify pane 2 doesn't contain "PANE1"
- Type `echo PANE2` in pane 2, verify pane 1 doesn't contain "PANE2"

### K11. Special Characters
- For each: `$`, `\`, `"`, `'`, `` ` ``, `|`
- `typeInTerminal(page, 'echo X')` → `pressEnter(page)` → verify character appears

### K12. Rapid 50-Character Typing
- Generate 50-char string → `typeInTerminal(page, string)` → `pressEnter(page)`
- `waitForTerminalText(page, string)` — verify all chars arrived in order

### K13. Prefix + `:` — Command Prompt
- `tmuxCommandKeyboard(page, 'display-message "CMDTEST"')`
- Verify no error, state consistent

## Mouse Scenarios

### M1. Click Pane to Select (2 Panes)
- Split to 2 panes, get bounding rects from `getUIPaneInfo(page)`
- Click center of each pane → verify `activePaneId` changes

### M2. Click Pane to Select (4 Panes)
- Create 4 panes, click each in sequence → verify active pane updates

### M3. SGR Mouse Click
- `startMouseCapture(ctx)` → click at known position → `readMouseEvents(1, 5000)`
- Verify PRESS event with correct col/row from `expectedSgrCoord()`

### M4. SGR Mouse Drag
- Mouse capture active → mousedown, move, mouseup → verify DRAG events

### M5. SGR Mouse Scroll
- Mouse capture active → `page.mouse.wheel(0, deltaY)` → verify SCROLL events

### M6. Pane Border Resize Drag
- 2 horizontal panes → drag border vertically → verify pane dimensions changed

### M7. Window Tab Click
- 2 windows → click first tab → verify active window switches

### M8. Float Close Button Click
- Open float → click close button → verify float removed

### M9. Double-Click Word Selection
- Type text → double-click word → verify copy mode entered

### M10. Click Outside Terminal Area
- Click at far edges → verify no crash or JS error

### M11. Rapid Clicks Across Panes
- 4 panes → 10 rapid alternating clicks → verify final active pane matches last click

### M12. Mouse Wheel Scroll
- Generate scrollback (`seq 1 200`) → scroll up → verify scrollback shown or copy mode entered
