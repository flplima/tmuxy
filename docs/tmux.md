# tmux Compatibility & Workarounds

This document covers tmux version-specific bugs, workarounds, and operational constraints relevant to Tmuxy development.

See [communication.md](communication.md) for the full control mode architecture and command routing rules.

## tmux Version

Tmuxy targets **tmux 3.5a**. Some bugs also affect 3.3a.

## `new-window` Crashes Control Mode

**Bug:** Sending `new-window` (or `neww`) through control mode stdin crashes the tmux server in tmux 3.5a. This also happens when `new-window` is called from a `run-shell` command while a control mode client is attached.

**Workaround:** Use `split-window` + `break-pane` as a compound command:

```
splitw -t <session> ; breakp
```

This creates a new pane in the current window, then immediately breaks it into its own window — replicating `new-window` behavior without the crash.

**Where it's applied:**
- `packages/web-server/src/sse.rs` — The `new_window` command handler, `execute_prefix_binding` for `c` key, and `run_tmux_command` all intercept `neww`/`new-window` and rewrite to `splitw ; breakp`.
- `scripts/tmuxy/` shell scripts — Use `split-window -dP` + `break-pane -d -s $PANE -n name` when creating windows from `run-shell`.
- `tests/helpers/TmuxTestSession.js` — Test session creation uses the same workaround.

## `%unlinked-window-close` Events

**Behavior:** When `kill-window` is used on a non-active window, tmux fires `%unlinked-window-close` instead of `%window-close`. Both event types must be handled to properly track window lifecycle.

**Where it's handled:**
- `packages/tmuxy-core/src/control_mode/parser.rs` — Parses both event types
- `packages/tmuxy-core/src/control_mode/state.rs` — Updates window state for both

## External `tmux` Commands While Control Mode Is Attached

**Bug:** Running external `tmux` commands (as separate processes) that modify session state while a control mode client is attached can crash the tmux server. Observed in tmux 3.3a and 3.5a.

**Rule:** All state-modifying commands must go through the control mode stdin connection. See [communication.md](communication.md) for the full list of commands that must use control mode vs. which are safe to run externally.

## Shell Scripts and `run-shell`

Shell scripts executed via tmux's `run-shell` command run inside the tmux server process, so they can safely call tmux CLI commands — except `new-window` (see above).

### Bash Variable Conflicts

`GROUPS` is a bash built-in variable (array of user group IDs). Never use it as a custom variable name in shell scripts — it silently contains the wrong value. Use `GRP_JSON` or similar instead.

### JSON in tmux Environment Variables

tmux doesn't handle newlines in environment variables. Always use `jq -c` (compact, single-line output) when storing JSON via `set-environment`.
