# OSC protocol support

## Summary
Parse `%output` stream to extract OSC sequences for hyperlinks and clipboard integration.

## Problem
The current `capture-pane` snapshot approach strips all OSC metadata:
- OSC 8 hyperlinks — URLs lost, can't make text clickable
- OSC 52 clipboard — copy operations from terminal apps don't reach browser

## Solution
Parse the raw `%output` stream (in addition to snapshots) to extract OSC sequences.

This is NOT full terminal emulation — we still use `capture-pane` for the rendered grid. We only parse `%output` to extract metadata that `capture-pane` discards.

## OSC Sequences to Support

| OSC | Function | Priority |
|-----|----------|----------|
| 8 | Hyperlinks | High |
| 52 | Clipboard | High |
| 0/2 | Window title | Medium |

### OSC 8 (Hyperlinks)
Format: `OSC 8 ; params ; uri ST ... text ... OSC 8 ; ; ST`

Store URL associations per cell coordinate. When rendering, wrap linked cells in `<a>` tags.

### OSC 52 (Clipboard)
Format: `OSC 52 ; Pc ; Pd ST` where Pd is base64-encoded text.

Intercept and use browser Clipboard API to copy to system clipboard. Requires user permission.

### OSC 0/2 (Window Title)
Map to pane title display in header.

## Implementation

### Phase 1: OSC Parser
1. In Rust backend, parse `%output` for OSC sequences before forwarding
2. Extract OSC data and send as separate metadata alongside state updates
3. Track hyperlink state: `Map<(row, col), url>`

### Phase 2: UI Integration
1. Hyperlinks: render cells with URL as `<a href>` with `target="_blank"`
2. Clipboard: on OSC 52, call `navigator.clipboard.writeText()`
3. Title: update pane header from OSC 0/2

## Non-Goals
- Full terminal emulation (cursor tracking, SGR state machine)
- Local scrollback buffer
- Image protocols (iTerm2/Kitty inline images)

## Success Criteria
- [ ] `%output` parsed for OSC sequences in backend
- [ ] OSC 8 hyperlinks render as clickable `<a>` tags
- [ ] OSC 52 clipboard copies to system clipboard
- [ ] OSC 0/2 updates pane title
- [ ] Still using `capture-pane` for grid rendering (not full emulation)
