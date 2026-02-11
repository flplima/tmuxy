# Fix pane stack feature

## Summary
Fix the pane stacking feature that allows tabbed panes within a single pane slot.

## Context
Pane stacks allow multiple panes to occupy the same screen space with tabs to switch between them. Inactive stack panes should live in hidden tmux windows (not shown in tmuxy window list). Switching tabs should swap panes via tmux.

## Current State
The feature exists but is broken. Stack windows are created but the switching/swapping logic doesn't work correctly.

## Success Criteria
- [ ] Can add a new pane to a stack (creates hidden tmux window)
- [ ] Stack tabs appear in pane header showing all panes in stack
- [ ] Clicking a stack tab swaps the visible pane with the clicked pane via `swap-pane`
- [ ] Hidden stack windows don't appear in tmuxy's window tab bar
- [ ] Closing a stack pane removes it and switches to another stack pane
- [ ] Closing the last pane in a stack removes the stack UI
- [ ] Stack state persists correctly across page reloads
