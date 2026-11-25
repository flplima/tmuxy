# Command strings: aliases, placeholders and shell names

What happens to a command string between a binding, the client and the shell that runs it. Part of [TMUX.md](TMUX.md).

## `list-keys` Reports Aliases Already Expanded

A `command-alias` is a config-time convenience, not something the client ever
sees. `bind -n C-l tmuxy-nav-right` reads back through `list-keys` — the source
the frontend builds its binding table from — as the alias's **expansion**:
`run-shell "bash …/bin/tmuxy/nav right #{pane_id}"`, the data dir in place of
the `$TMUXY_DATA_DIR` the alias names.

This matters because the client classifies each binding's command to decide
whether it can predict the result optimistically
(`tmuxy-ui/src/domain/store/parseCommand.ts`). Anything it fails to recognise
becomes a `RawCommand` — correct, but unpredicted, so the user waits out the
full round trip instead of seeing the result on the next frame. Matching only
the alias spelling is therefore a silent latency bug, not a parse error: the
key still works, it is just several hundred milliseconds slower. Any classifier
that keys off a bound command must match the **expanded** form (and may accept
the alias too, for commands built in-code).

## Client-Side Placeholder Substitution

Independent of tmux's own expansion, the frontend substitutes `#{pane_id}`, `#{pane_width}`, and `#{pane_height}` in every command that arrives as a string (`SEND_TMUX_COMMAND`: a binding, a command typed at the prompt) with the active pane's values (`expandPaneFormats` in `machines/app/dispatch.ts`). This is deliberate — prefix-binding commands are written against these placeholders. Typed text and pastes are ops (`SendText`, `PasteText`), never strings, so a placeholder in them reaches tmux as typed.

## Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts executed via `run-shell` — it silently contains the wrong value. Use `GRP_JSON` or similar instead.
