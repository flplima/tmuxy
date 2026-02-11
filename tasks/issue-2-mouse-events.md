# Handle mouse events

## Summary
Forward mouse events to tmux with proper encoding and context-aware behavior.

## Context
Currently mouse events may not be fully forwarded to tmux. Tmux supports mouse for selection, scrolling, pane resize, and application use (vim, htop, etc).

## SGR Mouse Encoding
Use SGR encoding (DECSET 1006) for mouse events:
- Format: `CSI < Cb ; Cx ; Cy M` (press) or `CSI < Cb ; Cx ; Cy m` (release)
- Button: 0=left, 1=middle, 2=right, 64=scrollUp, 65=scrollDown
- Modifier bits in Cb: 4=Shift, 8=Meta, 16=Ctrl

## Alternate Screen Detection
Subscribe to `#{alternate_on}` via `refresh-client -B` for each pane:
- When `alternate_on=1` (vim, less, htop): convert wheel events to Up/Down arrow keys
- When `alternate_on=0` (normal shell): wheel events scroll (or enter copy mode)

## Mouse Mode Detection
Query `#{mouse_any_flag}` to know if the application wants mouse events:
- When `mouse_any_flag=0`: click focuses pane, drag for UI operations
- When `mouse_any_flag=1`: forward mouse events as SGR sequences
- Override: Shift+click always does pane focus regardless of mouse mode

## Success Criteria
- [ ] Mouse clicks (left, right, middle) forwarded with SGR encoding
- [ ] Mouse coordinates correctly translated to pane-relative character grid
- [ ] Wheel events send arrows when in alternate screen, scroll otherwise
- [ ] Mouse drag forwarded for text selection in tmux
- [ ] Mouse works in terminal apps (vim, htop, less)
- [ ] Shift+click overrides mouse mode for pane focus
- [ ] Subscribe to `#{alternate_on}` and `#{mouse_any_flag}` per pane
