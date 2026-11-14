# E2E tests

The web E2E suites, the CLI suite (`cli/`), the desktop suites (`tauri/`,
`smoke/`) and their shared helpers (`helpers/`). How the layers fit together,
where a new test belongs and the rules every test follows are in
[docs/TESTS.md](../docs/TESTS.md); these notes are specific to this folder.

## A new file needs a shard

CI runs the web suites as the shards of `e2e-suites.json`: each entry's `path`
is a regex over the test file's path, and a new `*.test.js` here must match
exactly one entry (the `tmux` rerun aside), or it never runs — or runs twice.
`bin/ci/e2e-plan.test.mjs` asserts that over every file, so a file with no
shard fails `npm test`; add it to an entry, or add an entry, in that file.

## The CLI suite runs no real tmux

`cli/` runs the CLI's real scripts against a mock tmux, on a socket and a tmux socket directory made for the run. A helper there that starts a child process builds its environment with `scriptEnv()` or `sealedEnv()` (`tests/cli/helpers/env.js`): a child with any other environment is refused before it starts (`tests/cli/helpers/seal.js`), because one that inherits the shell's `$TMUX` or `TMUX_BIN` runs its kills on the session the suite was started from. Name the run's socket as `SOCKET` in an assertion, never `tmuxy`.

## Scrollback and copy mode

Scrollback is a client-side reimplementation with **two views** over one engine (`copyModeStates[paneId].mode`): the native-like `scroll` view a wheel/touch scroll opens (no cursor, browser selection, tmux never told) and tmux's `copy` mode from `prefix [` (cursor, vi keys, cell selection). Both render in `ScrollbackTerminal` and fetch history on demand. Drive them via real user input (`prefix [` and vi keys for copy mode; wheel/touch for the scroll view) and assert on the rendered scrollback and on the client engine via `getCopyModeState()` (the active pane's `window.app.view().copyMode`: mode, loaded rows, cursor, selection, scrollTop) — not `send-keys -X` tmux commands. Selecting text outside copy mode is the browser's own selection, so assert it with `window.getSelection()`, and never re-add a mouse path that opens copy mode. See [docs/COPY-MODE.md](../docs/COPY-MODE.md).
