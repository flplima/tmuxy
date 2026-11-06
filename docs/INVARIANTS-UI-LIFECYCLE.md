# Invariants — UI-mode records, session lifecycle

The `U` and `L` rows of the ledger in [INVARIANTS.md](INVARIANTS.md), which holds the column legend, the seam prefixes and the other rows. Same rules: cite a row in a commit on its seam, and a row's enforcer is a test title that exists.

## U — UI-mode records

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| U1 | At most one copy-mode record per pane; exit closes only if seen in mode, and cooldown ignores stale `in_mode`. | ordering | `copyMode.ts`, `docs/COPY-MODE.md` | `reconcilePaneMode.test.ts › a snapshot…`, `› is ignored…`; `copyMode.test.ts › the end of a blink…` (examples) |
| U2 | Resize preview holds for two matching quiet updates or a 2 s fallback that never clobbers newer resizes. | liveness | `appMachine.ts`, `layout.ts` | `layout.test.ts › the 2s RESIZE_COMPLETED…`, `› …does not clobber…` (two-quiet-updates hold is —) |
| U3 | Only the latest scrollback fetch per pane applies; different panes fetch concurrently without cancelling. | ordering | `tmuxActor.ts` | `tmuxActor.test.ts › interrupts the previous fetch…`, `› different paneId fetches…` |
| U4 | Group switch holds swap over stale snapshots, drops if a pane dies, and never selects parked/stash panes. | safety | `appMachine.ts`, `windowOps.ts` | `tests/7-regression-bugs.test.js › Clicking three pane-group tabs…` [nightly] (E2E only) |
| U5 | Every menu renders a spec in the `domain/menus/spec.ts` vocabulary and dispatches its item's typed action (an op, a `MENU_COMMANDS` verb, a machine event or the surface's own verb) through `useMenuDispatch`. | safety | `components/menus/specs/`, `SpecMenu.tsx`, `nativeMenu.ts` | `specs.test.ts`; `actions.test.ts › every command runs something` |

## L — session lifecycle

| Id | Invariant | Kind | Stated in | Enforced by |
| --- | --- | --- | --- | --- |
| L1 | Snapshot restore runs after attach/sync and holds autosave from before spawn so placeholders aren't saved and live sessions aren't overwritten. | ordering | `transport.rs`, `session_snapshot.rs` | `session_snapshot/tests_restore.rs › a_restore_in_flight…`; `transport/tests.rs › a_running_session_is_not_restored_over` |
| L2 | Restore plans avoid `new-window`, split panes in index order, apply layouts after splits, and restore focus last. | ordering | `session_snapshot.rs` | `session_snapshot/tests_restore.rs › a_restore_never_uses…`, `session_snapshot/tests_storage.rs › focus_is_restored_last`, `session_snapshot/tests_restore.rs › a_reordered_group…`; `tests/15-session-snapshot.test.js › the shape survives…` [nightly] |
| L3 | New sessions are never created on a closing connection. | safety | `appMachine.ts`, `HttpAdapter.ts` | `tests/4-session-connectivity.test.js` (regression example) |
| L4 | Disconnect during `connecting` transitions to `disconnected`, never a stuck spinner. | liveness | `appMachine.ts` (`connecting`) | `disconnected.test.ts › ends a connection…`, `› ends a reconnection…` |
| L5 | Every `source-file` of the chain (connect, reload, a client's Reload Config) sources this process's own entry file, rebuilt just before from the current `use-tmux-conf` choice and `tmuxy.conf`; the entry publishes the data dir the scripts are named by before any layer. | ordering | `session/config.rs`, `transport.rs` | `transport/tests.rs › a_client_reload_sources_this_processs_own_entry_file`; `tests_layout.rs › the_chain_is_in_the_state_dir…`; `16-personalization.test.js › Reload Config sources the chain rebuilt…` |
| L6 | `GET /events` never creates a session (a missing one is a `404`); only `ensure_session` does, counting and spawning under one lock against `MAX_AUTO_CREATED_SESSIONS`, and a monitor started for an existing session never recreates it. | safety | `sse.rs`, `sse/clients.rs`, `sse/monitor.rs` | `state/tests.rs › events_route_does_not_auto_create_missing_sessions` (the cap under the lock and the monitor are —) |
| L7 | Every `source-file` of the chain (connect, reload, a client's Reload Config) is followed by the plugins on the same connection: the inventory republished, then the key tables read back with `query`, after the config ran, and the plugin keys bound from them, so a key the config just bound stays the user's. A saved `tmuxy-plugin.toml` reloads like `tmuxy.conf`. | ordering | `transport/bindings.rs`, `transport/plugins.rs`, `plugins/keys.rs` | `tests_links.rs › key_commands_keep_a_users_binding_and_drop_stale_plugin_ones` (the plan from the tables read); `18-plugin-links-keys-themes.test.js › a plugin key is bound at once…` (end to end; the read-after-config order is —) |
