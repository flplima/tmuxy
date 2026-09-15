# E2E tests

## Scrollback and copy mode

Scrollback is a client-side reimplementation with **two views** over one engine (`copyModeStates[paneId].mode`): the native-like `scroll` view a wheel/touch scroll opens (no cursor, browser selection, tmux never told) and tmux's `copy` mode from `prefix [` (cursor, vi keys, cell selection). Both render in `ScrollbackTerminal` and fetch history on demand. Drive them via real user input (`prefix [` and vi keys for copy mode; wheel/touch for the scroll view) and assert on the rendered scrollback and on the client engine via `getCopyModeState()` (reads `copyModeStates[paneId]`: mode, loaded lines, cursor, selection, scrollTop) — not `send-keys -X` tmux commands. Selecting text outside copy mode is the browser's own selection, so assert it with `window.getSelection()`, and never re-add a mouse path that opens copy mode. See docs/COPY-MODE.md.
