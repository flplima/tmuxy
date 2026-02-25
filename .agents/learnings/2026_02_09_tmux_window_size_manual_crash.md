# tmux 3.3a Crash with `window-size manual` and Control Mode

## Problem

tmux 3.3a crashes when using `new-window` or `neww` commands through control mode while `window-size manual` is set.

## Symptoms

```
%exit server exited unexpectedly
```

The tmux server crashes completely, destroying all sessions.

## Cause

The combination of:
1. `set -g window-size manual` in tmux configuration
2. Control mode client attached (`tmux -CC attach`)
3. Running `new-window` or `neww` command through control mode

## Workaround

Use `window-size latest` instead of `window-size manual`:

```tmux
# CRASHES with control mode:
# set -g window-size manual

# WORKS with control mode:
set -g window-size latest
```

## Details

- `window-size manual` requires clients to explicitly resize windows via `resize-window` commands
- `window-size latest` sizes windows based on the most recently used client
- The crash only occurs when sending `new-window`/`neww` commands; `split-window` works fine
- The crash happens even with `-d` flag (`new-window -d`)
- The crash happens even if you resize the window first

## Tested

- tmux version: 3.3a
- Platform: Linux 6.17.0-12-generic (Ubuntu)
- Date: 2026-02-09

## Fix Location

Changed in `/workspace/docker/.tmuxy.conf`:
```diff
- set -g window-size manual
+ set -g window-size latest
```

This fixed the E2E tests which were crashing when creating new windows through the SSE/HTTP → control mode pipeline.
