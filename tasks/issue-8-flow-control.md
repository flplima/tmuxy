# Flow control / backpressure

## Summary
Enable tmux's `pause-after` mechanism to prevent unbounded memory growth during heavy output.

## Problem
When a command produces massive output (e.g., `yes`, `cat large_file`), tmux streams `%output` continuously. If the UI can't keep up, the buffer grows unboundedly until tmux disconnects the client at 5 minutes.

## Solution
Use tmux 3.2+ `pause-after` flow control:

```
refresh-client -f pause-after=5
```

This enables `%extended-output` with timing info and automatic pausing:
```
%extended-output %pane-id milliseconds-behind : output-data
```

When output falls too far behind:
1. tmux sends `%pause %pane-id`
2. Client catches up (optionally uses `capture-pane` for current state)
3. Client sends `refresh-client -A '%pane-id:continue'`
4. tmux sends `%continue %pane-id` and resumes

## Implementation
1. On connect: `refresh-client -f pause-after=5`
2. Parse `%extended-output` and monitor `milliseconds-behind`
3. Handle `%pause` notification — show "output paused" indicator
4. Send continue command after processing backlog
5. Optional: WebSocket backpressure with high/low watermarks on server

## Success Criteria
- [ ] `pause-after` enabled on connection
- [ ] `%pause` handled gracefully with UI indicator
- [ ] `%continue` sent to resume output
- [ ] No unbounded memory growth during heavy output
- [ ] App remains responsive during output bursts
