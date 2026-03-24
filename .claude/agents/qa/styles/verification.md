# Verification Style — Fix Validation

Validate that a specific bug fix actually resolves the issue without introducing regressions.

## Setup

- Session name: `tmuxy-qa`
- Browser URL: `http://localhost:9000/?session=tmuxy-qa`
- Key helpers: all helpers in `/workspace/tests/helpers/` (use what the issue requires)
- The prompt will include an issue number — read the full issue for context

## Reading the Issue

```bash
gh issue view <number> --json body,comments,labels
```

From the issue, extract:
- **Reproduction steps** — the exact steps to trigger the bug
- **Expected behavior** — what should happen
- **Category** — determines which checks to run (see category-specific checks below)
- **Worker's fix description** — in the comments, explains what was changed

## Verification Process

### 1. Run Reproduction Steps
- Follow the reproduction steps from the issue exactly
- Verify the bug is **no longer present**

### 2. Run Health Checks
- `assertLayoutInvariants(page)` — verify no layout violations
- `assertStateMatches(page)` — verify UI/tmux state consistency

### 3. Run Test Suites
```bash
npm test          # Unit tests
npm run test:e2e  # E2E tests
```
All tests must pass. A regression means the fix failed.

### 4. Category-Specific Checks

#### state-drift issues
- `compareSnapshots(ui, tmux)` — must return 0 mismatches
- Test with multiple pane/window configurations

#### visual-glitch issues
- Use `GlitchDetector` during the operation that triggered the bug
- Verify no node flickers, size jumps, or orphaned nodes

#### input issues
- Replay the exact key/mouse interactions from the issue
- Verify correct events are generated

#### performance issues
- Re-measure the operation timing
- Verify within acceptable threshold
- Compare against baselines in `.claude/baselines/performance.json`

## Verification Checklist

For every fix, verify ALL of these:
- Original reproduction steps no longer trigger the bug
- `assertLayoutInvariants(page)` passes
- `assertStateMatches(page)` passes
- `npm test` passes
- `npm run test:e2e` passes
- No new console errors in the browser
- Fix is minimal (no unnecessary changes)
- No skipped tests introduced
- No `eslint-disable` comments added

## Evidence Format

Report for each check:
- Check name
- Result: pass or fail
- Details if failed (error message, state diff, timing data)

## Result Reporting

Comment the verification result on the GitHub issue:

```bash
gh issue comment <N> --body "$(cat <<'EOF'
## Verification Result: PASS

- Reproduction steps: PASS
- Layout invariants: PASS
- State consistency: PASS
- Unit tests: PASS
- E2E tests: PASS

No regressions detected.
EOF
)"
```

Or if verification fails:

```bash
gh issue comment <N> --body "$(cat <<'EOF'
## Verification Result: FAIL

- Reproduction steps: PASS
- Layout invariants: PASS
- State consistency: PASS
- Unit tests: PASS
- E2E tests: FAIL — tests/pane-ops.test.js: Expected 2 panes, got 1

<additional evidence>
EOF
)"
```
