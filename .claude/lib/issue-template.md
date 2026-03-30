# Issue Template

Use this template when filing bug reports via GitHub Issues.

## Title Format

`[<agent>] <one-line summary>`

Examples:
- `[snapshot] Pane count mismatch after split+kill cycle`
- `[flicker] Size jump during horizontal split`
- `[input] SGR mouse click reports wrong column`
- `[perf] Window create latency 3x above baseline`

## Labels

Every issue gets these labels:
- `qa-bug` (always)
- `status:open` (initial status)
- `category:<category>` (state-drift, visual-glitch, input, performance)
- `severity:<level>` (critical, high, medium, low)

## Body Template

```markdown
## Reproduction Steps
1. Start with a clean tmux session
2. <step>
3. <step>
4. ...

## Expected
<What should happen>

## Actual
<What actually happened>

## Evidence
<Raw data: snapshot diff output, glitch timeline, timing measurements>

## Test Code
```javascript
// Minimal runnable reproduction using test helpers
// Include imports and setup so the worker can run it directly
```
```

## Severity Guide

| Level | Criteria |
|-------|----------|
| **critical** | Crash, data loss, tmux session corruption |
| **high** | Feature completely broken, wrong state after operation |
| **medium** | Visual glitch, performance regression >50%, intermittent failure |
| **low** | Minor cosmetic issue, edge case, <50% performance regression |

## Category Guide

| Category | When to use |
|----------|------------|
| `state-drift` | UI state doesn't match tmux state |
| `visual-glitch` | Flicker, orphaned nodes, size jumps, layout invariant violation |
| `input` | Click/drag/scroll/key input not working correctly |
| `performance` | Operation exceeds threshold or regresses from baseline |
