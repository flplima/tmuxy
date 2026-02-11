# Session reconnection

## Summary
Auto-reconnect when WebSocket drops, with full state recovery.

## Problem
Currently, WebSocket disconnection shows an error state requiring manual page refresh. Network hiccups, laptop sleep, or server restarts shouldn't require user intervention.

## Solution
Implement reconnection with exponential backoff and state recovery:

1. Detect WebSocket close → enter "reconnecting" state
2. Retry with backoff: 1s, 2s, 4s, 8s, max 30s
3. On reconnect: full re-sync via tmux commands
4. Keep last-known state displayed during reconnect (don't clear screen)

## State Recovery
tmux IDs (`$session`, `@window`, `%pane`) are stable for object lifetime.

On reconnect:
1. `list-sessions` / `list-windows` / `list-panes` — verify structure
2. `capture-pane -t %pane-id -p -e` — capture current content for each pane
3. `refresh-client -f pause-after=N` — re-enable flow control
4. `refresh-client -B name:what:format` — re-subscribe to format changes

## Implementation
1. WebSocket close handler → set state to "reconnecting"
2. Show reconnection indicator in UI
3. Exponential backoff retry loop
4. On success: full state sync, clear indicator
5. If session gone: show session picker
6. Ping/keepalive: WebSocket ping every 5-10s to detect stale connections early

## Success Criteria
- [ ] Auto-reconnect on WebSocket drop
- [ ] Exponential backoff (1s → 30s max)
- [ ] UI shows reconnection indicator
- [ ] Last-known state preserved during reconnect
- [ ] Full state recovery after reconnect
- [ ] Session picker shown if session no longer exists
- [ ] Keepalive pings detect stale connections
