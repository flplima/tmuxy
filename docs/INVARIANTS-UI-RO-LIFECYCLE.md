# Invariants — UI-mode records, read-only clients, session lifecycle

The `U`, `R` and `L` rows of the ledger in [INVARIANTS.md](INVARIANTS.md), which holds the column legend, the seam prefixes and the other rows. Same rules: cite a row in a commit on its seam, and a row's enforcer is a test title that exists.

## U — UI-mode records

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| U1 | At most one copy-mode record per pane; exit closes only if seen in mode, cooldown ignores stale `in_mode`, and viewers never auto-enter. | ordering | `copyMode.ts`, `docs/COPY-MODE.md` | `reconcilePaneMode.test.ts › a snapshot…`, `› is ignored…`, `› never happens…`; `copyMode.test.ts › the end of a blink…` (examples) |
| U2 | Resize preview holds for two matching quiet updates or a 2 s fallback that never clobbers newer resizes. | liveness | `appMachine.ts`, `layout.ts` | `layout.test.ts › the 2s RESIZE_COMPLETED…`, `› …does not clobber…` (two-quiet-updates hold is —) |
| U3 | Only the latest scrollback fetch per pane applies; different panes fetch concurrently without cancelling. | ordering | `tmuxActor.ts` | `tmuxActor.test.ts › interrupts the previous fetch…`, `› different paneId fetches…` |
| U4 | Group switch holds swap over stale snapshots, drops if a pane dies, and never selects parked/stash panes. | safety | `appMachine.ts`, `windowOps.ts` | `tests/7-regression-bugs.test.js › Clicking three pane-group tabs…` [nightly] (E2E only) |
| U5 | Every menu renders a `domain/menus/` spec and dispatches via `executeMenuAction` or machine events. | safety | `domain/menus/`, `SpecMenu.tsx`, `nativeMenu.ts` | `specs.test.ts`; `menuActions.test.ts › sends the op of every op-backed item…` |

## R — read-only clients

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| R1 | Read-only clients allow only read commands, cancel mutations, and never send a viewport. | safety | `readOnly.ts`, `HttpAdapter.ts`, `stateFeed.ts` | `HttpAdapter.test.ts › a read-only server…`; `tests/10-read-only.test.js › viewer follows output…`, `› a viewer cannot reach…` |
| R2 | Read-only store predicts only local focus, and `notReadOnly` drops mutating events before side effects. | safety | `TmuxStore.ts`, `readOnlyGuard.ts`, `tmuxActor.ts` | `TmuxStore.test.ts › refuses anything…`, `› a tab switch…`, `› pane focus is kept…`; guard is E2E only (`tests/10-read-only.test.js`) |

## L — session lifecycle

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| L1 | Snapshot restore runs after attach/sync and holds autosave from before spawn so placeholders aren't saved and live sessions aren't overwritten. | ordering | `transport.rs`, `session_snapshot.rs` | `session_snapshot.rs › a_restore_in_flight…`; `transport.rs › a_running_session_is_not_restored_over` |
| L2 | Restore plans avoid `new-window`, split panes in index order, apply layouts after splits, and restore focus last. | ordering | `session_snapshot.rs` | `session_snapshot.rs › a_restore_never_uses…`, `› focus_is_restored_last`, `› a_reordered_group…`; `tests/15-session-snapshot.test.js › the shape survives…` [nightly] |
| L3 | New sessions are never created on a closing connection. | safety | `appMachine.ts`, `HttpAdapter.ts` | `tests/4-session-connectivity.test.js` (regression example) |
| L4 | Disconnect during `connecting` transitions to `disconnected`, never a stuck spinner. | liveness | `appMachine.ts` (`connecting`) | `disconnected.test.ts › ends a connection…`, `› ends a reconnection…` |
