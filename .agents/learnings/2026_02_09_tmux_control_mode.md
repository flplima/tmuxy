# Tmux Control Mode Learnings

Date: 2026-02-09

## Summary

All tmux commands must be sent through the control mode stdin connection, not via external subprocess calls. Running external `tmux` commands while control mode is attached causes crashes in tmux 3.3a.

## Key Discovery

When tmux control mode (`tmux -CC`) is attached to a session:
- **External subprocess calls crash tmux 3.3a**: Running `tmux new-window` (or similar) as a separate process causes the tmux server to exit unexpectedly
- **Control mode stdin works correctly**: Sending the same command (`neww`) through the control mode connection works perfectly

This was identified by testing `new-window` in different scenarios:
```bash
# CRASHES: External subprocess while control mode attached
tmux new-window -t session

# WORKS: Same command sent through control mode stdin
echo "neww" | tmux -CC attach -t session
```

## Documentation Reference

The [tmux Control Mode wiki](https://github.com/tmux/tmux/wiki/Control-Mode) clearly states:
> "tmux commands or command sequences may be sent to the control mode client"

Example from docs:
```
new -n mywindow
```

## Implementation

### Architecture
```
Frontend → WebSocket → send_via_control_mode() → Monitor → stdin → tmux -CC
                                                     ↑
Events:  Frontend ← WebSocket ← Monitor ← stdout ← tmux -CC
```

### Helper Function
```rust
async fn send_via_control_mode(state: &Arc<AppState>, session: &str, command: &str) -> Result<(), String> {
    let command_tx = {
        let sessions = state.sessions.read().await;
        sessions.get(session).and_then(|s| s.monitor_command_tx.clone())
    };

    if let Some(tx) = command_tx {
        tx.send(MonitorCommand::RunCommand { command: command.to_string() })
            .await
            .map_err(|e| format!("Monitor channel error: {}", e))
    } else {
        Err("No monitor connection available".to_string())
    }
}
```

## Short Command Forms

Tmux commands have short aliases that should be preferred:

| Long Form | Short Form |
|-----------|------------|
| `new-window` | `neww` |
| `split-window` | `splitw` |
| `select-pane` | `selectp` |
| `select-window` | `selectw` |
| `kill-pane` | `killp` |
| `kill-window` | `killw` |
| `resize-pane` | `resizep` |
| `resize-window` | `resizew` |
| `send-keys` | `send` |
| `next-window` | `next` |
| `previous-window` | `prev` |
| `last-window` | `last` |
| `next-layout` | `nextl` |
| `break-pane` | `breakp` |

Note: `new` is short for `new-session`, NOT `new-window`. Use `neww` for creating windows.

## Commands Updated

All these WebSocket handlers now route through control mode:
- `send_keys_to_tmux` → `send -t {session} {keys}`
- `split_pane_horizontal/vertical` → `splitw -t {session} -h/-v`
- `new_window` → `neww -t {session}`
- `select_pane/window` → `selectp/selectw`
- `next/previous_window` → `next/prev`
- `kill_pane/window` → `killp/killw`
- `resize_pane` → `resizep`
- `scroll_pane` → `copy-mode ; send -X scroll-up/down`
- `execute_prefix_binding` → direct command mapping
- `run_tmux_command` → pass through to control mode

## Testing

Verify control mode is working:
```bash
# Check that commands go through control mode
pm2 logs tmuxy-dev --nostream | grep "control mode"

# Verify tmux server is healthy
tmux list-sessions
tmux list-windows -t tmuxy
```

## Lessons Learned

1. Always read and follow the official documentation
2. Control mode is designed for applications - use it as intended
3. External subprocess calls are for CLI usage, not when control mode is attached
4. Test commands in isolation to identify the failure point
5. Short command forms reduce bandwidth and are standard in control mode examples
