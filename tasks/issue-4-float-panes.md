# Implement floating pane feature

## Summary
Add Zellij-style floating panes that overlay the tiled layout and can be freely positioned/resized.

## Research Summary (Zellij Reference)

### How Zellij Does It
- Floating panes are independent windows that overlay tiled panes
- Toggle visibility with a single keybinding (Ctrl+P, W)
- Convert between tiled and floating modes (Ctrl+P, E)
- Floating panes persist in background when hidden
- Support pinning (always-on-top) for monitoring panes
- Mouse drag to move, resize handles for sizing
- Position tracking: desired position vs current position (for terminal resize handling)

### Key UX Patterns
- **Toggle float view**: Single keybinding shows/hides ALL floating panes
- **Create float**: If no floats exist when toggling, create one
- **Pin/unpin**: Keep specific floats visible even when working in tiled panes
- **Convert**: Transform tiled pane to float and vice versa
- **Stacking**: Multiple floats can overlap

## Proposed Implementation

### Architecture
1. **Float panes live in hidden tmux windows** (like stack panes)
   - Window naming convention: `__float_{pane_id}`
   - These windows don't appear in tmuxy's window tab bar

2. **State stored in tmux metadata** (survives tmuxy reload)
   - Position: `@float_x`, `@float_y` (character grid coordinates)
   - Size: `@float_width`, `@float_height` (character dimensions)
   - Visible: `@float_visible` (boolean)
   - Pinned: `@float_pinned` (boolean)

3. **Helper panes for sizing** (optional, for tmux-native size control)
   - Two blank panes in float window to help set dimensions via tmux resize

### Float View Rendering
- When float view is active, render current window's tiled panes normally
- Overlay floating panes on top with absolute positioning
- Each float pane has:
  - Draggable header bar
  - Resize handles on edges/corners
  - Close button
  - Pin toggle button

### Keybindings (Prefix + key)
- `Prefix + f` - Toggle float view (show/hide all floats)
- `Prefix + F` - Create new floating pane
- `Prefix + Shift+E` - Convert current pane to float / embed float

### Mouse Interactions
- **Drag header**: Move float pane (update `@float_x`, `@float_y`)
- **Drag edges/corners**: Resize float pane (update `@float_width`, `@float_height`)
- **Click inside**: Focus the float pane
- **Click pin icon**: Toggle pinned state

### State Machine Updates
- Add `floatPanes` to context (derived from windows with `__float_` prefix)
- Add `floatViewVisible` boolean
- Add drag/resize state for float panes (similar to existing drag machine)
- Events: `TOGGLE_FLOAT_VIEW`, `CREATE_FLOAT`, `CONVERT_TO_FLOAT`, `PIN_FLOAT`

## Success Criteria
- [ ] Toggle float view shows/hides all floating panes
- [ ] Can create a new floating pane (opens in hidden tmux window)
- [ ] Float panes render as overlay above tiled layout
- [ ] Mouse drag on float header moves the pane
- [ ] Mouse drag on float edges/corners resizes the pane
- [ ] Float position/size persists in tmux metadata
- [ ] Float state survives tmuxy page reload
- [ ] Can convert tiled pane to float and vice versa
- [ ] Can pin floats to stay visible when float view is hidden
- [ ] Hidden float tmux windows don't appear in window tab bar
- [ ] Float panes receive keyboard input when focused

## References
- [Zellij Floating Panes](https://zellij.dev/news/floating-panes-tmux-mode/)
- [Zellij Pinned Panes](https://zellij.dev/news/stacked-resize-pinned-panes/)
