# Postmortem: Uncommitted Work Recovery

Date: 2026-02-11

## Incident Summary

The repository accumulated **47 modified files** and **60+ untracked files** over 2+ days without commits. This included critical architecture documentation, new state machine infrastructure, UI components, and backend changes. A broken import caused the UI to fail, requiring emergency stabilization before work could continue.

## Timeline

- **2026-02-09**: Last significant commit (E2E test suite completion)
- **2026-02-09 to 2026-02-11**: Continuous development without commits
  - Major state machine refactor (appMachine.ts → machines/app/)
  - New drag/resize child machines
  - Terminal component rewrite for structured cells
  - Backend control mode routing changes
  - Architecture documentation created
- **2026-02-11**: Broken import discovered, UI wouldn't render
- **2026-02-11**: Recovery plan created and executed (9 commits)

## What Went Wrong

### 1. No Incremental Commits
Development proceeded for 2+ days without any commits. This created:
- **Large blast radius**: A single broken import affected understanding of what was working
- **Unclear feature boundaries**: Hard to tell which changes were complete vs in-progress
- **Risk of data loss**: All work existed only in the working directory
- **Difficult debugging**: No way to bisect or revert to known-good states

### 2. Deleted File Without Committing Replacement
The old `appMachine.ts` was deleted and replaced with `machines/app/` directory, but neither the deletion nor the new files were committed. This made it unclear whether the refactor was complete.

### 3. Mixed Concerns in Working Directory
The uncommitted changes included:
- Completed, working features
- Work-in-progress features
- Bug fixes
- Documentation
- Configuration changes

Without commits, it was impossible to distinguish between these categories.

### 4. No Verification Before Large Changes
The control mode routing change (critical for tmux 3.3a stability) was made without first committing the existing working state. If this change had broken something, there would be no easy rollback.

## What Went Right

### 1. Documentation Was Created
Despite not committing, architecture documentation and learnings were written:
- `ARCHITECTURE.md` - System overview
- `learnings/2026_02_09_tmux_control_mode.md` - Critical tmux behavior
- Task tracking documents

This documentation made the recovery plan much easier to create.

### 2. TypeScript Caught the Broken Import
The broken import was caught by TypeScript compilation, not discovered in production. Static typing prevented a worse outcome.

### 3. Recovery Was Possible
Because git tracks the working directory state, all changes were recoverable. The recovery plan could be executed systematically.

## Lessons Learned

### 1. Commit Early, Commit Often
**Rule**: Commit after completing any discrete unit of work:
- A bug fix
- A new component
- A refactor step
- Documentation

**Rationale**: Small commits are easier to review, revert, and understand. They also provide natural checkpoints for testing.

### 2. Commit Before Deleting
**Rule**: Before deleting a file that's being replaced, commit the replacement first.

**Example**:
```bash
# Good
git add machines/app/
git commit -m "Add new app machine structure"
git rm machines/appMachine.ts
git commit -m "Remove old appMachine.ts (replaced by machines/app/)"

# Bad
rm machines/appMachine.ts  # No commit, replacement not committed either
```

### 3. Commit Before Risky Changes
**Rule**: Before making changes that could break things (especially backend/infrastructure), commit the current working state.

**Rationale**: Provides a rollback point if the change causes problems.

### 4. Use Feature Branches for Large Changes
**Rule**: For refactors that touch many files, use a feature branch.

**Rationale**:
- Main branch stays stable
- Progress can be committed without affecting others
- Easy to abandon if approach doesn't work

### 5. Daily Commit Checkpoint
**Rule**: At minimum, commit all work at the end of each day.

**Rationale**: Prevents multi-day accumulation of uncommitted work. Also serves as a backup.

## Recovery Process Used

The recovery followed this pattern:

1. **Assess**: `git status` to understand scope
2. **Verify**: `npx tsc --noEmit` to check TypeScript compiles
3. **Plan**: Group changes by logical concern
4. **Commit incrementally**: One commit per logical group
5. **Verify after each commit**: Ensure nothing broke
6. **Document**: Create this postmortem

### Commit Groups (in order)

1. UI fixes (modified files that fix broken imports)
2. Architecture documentation (new docs)
3. State machine infrastructure (new machines/)
4. Components and utilities (new components, hooks, utils)
5. Backend changes (Rust changes)
6. E2E test updates (test files)
7. Config and scripts (package.json, scripts/)
8. Bug fixes discovered during recovery (viewport sizing)
9. Task/planning documents

## Action Items

### Immediate
- [x] Commit all uncommitted work (completed)
- [x] Document this incident (this file)
- [x] Push to remote as backup

### Process Changes
- [ ] Add pre-push hook to warn if >10 files changed without recent commit
- [ ] Consider CI check for uncommitted file count in dev environment
- [ ] Add "commit checkpoint" reminder to end-of-day routine

### Technical Debt
- [ ] Fix floating panes `float_pane_id` backend gap
- [ ] Clean up temporary files (screenshots, core dumps)
- [ ] Review and potentially gitignore debug artifacts

## Metrics

| Metric | Value |
|--------|-------|
| Days without commit | 2+ |
| Modified files | 47 |
| Untracked files | 60+ |
| Recovery commits | 9 |
| Time to recover | ~1 hour |
| Data lost | None |

## Conclusion

This incident was a near-miss. All work was recovered, but the situation could have been worse if:
- A disk failure had occurred
- The working directory had been accidentally reset
- More files had conflicting changes

The key takeaway is that **git commits are cheap, but lost work is expensive**. Committing frequently provides safety nets, clear history, and easier debugging with minimal overhead.
