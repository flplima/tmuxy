# GitHub Issues Coordination Protocol

All QA agents coordinate via **GitHub Issues** and **tmuxy events**. No task files are used.

## Event-Based Coordination

Agents communicate via `tmuxy event` — a file-based message queue with `tmux wait-for` signaling:

```bash
# Manager sends work
tmuxy event emit start_dev 'Fix issue #42: ...'
tmuxy event emit start_qa 'Run snapshot style'

# Dev/QA while-loops block until event arrives
data=$(tmuxy event wait start_dev)
claude -p "$data" --agent dev --dangerously-skip-permissions --verbose
```

Events are queued (ordered, single-consumer). Multiple emits before a wait are delivered in order. Emit-before-wait works correctly (messages persist as files).

## Labels

### Status labels (mutually exclusive)
| Label | Meaning |
|-------|---------|
| `status:open` | New bug, awaiting triage or worker pickup |
| `status:fixing` | Worker is investigating/fixing |
| `status:verifying` | Fix submitted, awaiting verifier |
| `status:closed` | Verified and resolved |
| `status:rejected` | Fix failed verification, needs rework |

### Severity labels
| Label | Criteria |
|-------|----------|
| `severity:critical` | Crash, data loss, tmux session corruption |
| `severity:high` | Feature completely broken, wrong state after operation |
| `severity:medium` | Visual glitch, performance regression >50%, intermittent failure |
| `severity:low` | Minor cosmetic issue, edge case, <50% performance regression |

### Category labels
| Label | When to use |
|-------|------------|
| `category:state-drift` | UI state doesn't match tmux state |
| `category:visual-glitch` | Flicker, orphaned nodes, size jumps, layout invariant violation |
| `category:input` | Click/drag/scroll/key input not working correctly |
| `category:performance` | Operation exceeds threshold or regresses from baseline |

All issues also get the `qa-bug` label.

## User Filtering (Script-Level)

Only issues authored by `flplima` or `laika-assistant` are processed. This is enforced at the script level in `.claude/lib/gh-issues.sh` — not via prompts.

Priority: `flplima` issues always take precedence over `laika-assistant` issues.

## Flow

```
QA agent finds bug
  --> QA creates GitHub Issue (status:open, with labels)

Manager triages
  --> gh issue edit --remove-label status:open --add-label status:fixing
  --> tmuxy event emit start_dev 'Fix issue #N: ...'

Dev implements fix
  --> Comments progress on the issue
  --> Commits with: <gitmoji> (#N) <summary>
  --> Comments completion on the issue
  --> claude -p exits, while-loop waits for next event

Manager reviews
  --> Checks git diff, runs npm test
  --> gh issue edit --remove-label status:fixing --add-label status:verifying
  --> tmuxy event emit start_qa 'Verify fix for issue #N'

QA verifies
  --> PASS: Comments on issue, manager closes it
  --> FAIL: Comments on issue, manager adds status:rejected, reassigns dev
```

## Commit Message Format

```
<gitmoji> (#<issue>) <short summary>

<optional detailed description>
```

Example:
```
🐛 (#42) Fix ghost cursor when TUI app hides cursor via DECTCEM

Added cursor_hidden field through the entire data pipeline. Rust backend
derives cursor_hidden from vt100 emulator's hide_cursor() on each %output
event. Frontend hides cursor block when application requests DECTCEM off.
```

## Commands Reference

```bash
# Source the helper script for filtered issue queries
source .claude/lib/gh-issues.sh
gh_issues_open          # All open issues, prioritized (flplima first)
gh_issues_next          # Single highest-priority issue
gh_issues_summary       # One-line summaries
gh_issues_by_status "status:fixing"

# File a new bug
gh issue create --title "[agent] summary" --label "qa-bug,status:open,..." --body "..."

# Assign to dev
gh issue edit <N> --remove-label "status:open" --add-label "status:fixing"

# Submit for verification
gh issue edit <N> --remove-label "status:fixing" --add-label "status:verifying"

# Close as verified
gh issue close <N> --comment "Verified and closed."

# Reject a fix
gh issue edit <N> --remove-label "status:verifying" --add-label "status:rejected"
gh issue comment <N> --body "Rejected: <feedback>"
```
