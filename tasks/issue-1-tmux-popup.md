# Handle tmux popup support

## Summary
Add support for tmux popups (`display-popup` command) in the tmuxy UI.

## Context
Tmux 3.2+ supports popup windows that overlay the current view. These are commonly used for fuzzy finders (fzf), git UIs, and quick commands.

## Success Criteria
- [ ] Detect when a tmux popup is active via control mode events
- [ ] Render the popup content as an overlay centered above the current pane layout
- [ ] Support popup sizing and positioning as specified by tmux
- [ ] Popup closes correctly and returns to normal view
- [ ] Keyboard input routes to the popup when active
