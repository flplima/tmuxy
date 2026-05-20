# Window Tags

tmuxy distinguishes windows it manages from foreign tmux windows using a set of per-window tmux user-options under the `@tmuxy-*` namespace. The discriminator option, `@tmuxy-window-type`, replaces the legacy `__float_*` / `__group_*` name-prefix conventions.

This document is the canonical reference for the schema and the source of truth for the migration that introduces it.

## Filtering rule

A tmux window is **tmuxy-managed** if and only if `@tmuxy-window-type` is set on it. Windows without this option are foreign and tmuxy ignores them everywhere (tab list, selectors, snapshot diffing). Window names are purely cosmetic and never used to infer type.

## Schema

All options are scoped per window (`set-option -w -t <window-id>`).

| Option | Values | Set on |
|---|---|---|
| `@tmuxy-window-type` | `tab` \| `float` \| `float-backdrop` \| `group` | every tmuxy-managed window |
| `@tmuxy-float-parent` | `@<window-id>` | floats and float-backdrops |
| `@tmuxy-float-width` | integer or percentage | floats |
| `@tmuxy-float-height` | integer or percentage | floats |
| `@tmuxy-float-drawer` | `top` \| `bottom` \| `left` \| `right` \| unset | drawer-style floats |
| `@tmuxy-float-bg` | `blur` \| `dim` \| unset | floats with a backdrop |
| `@tmuxy-float-noheader` | `1` \| unset | floats that hide the header chrome |
| `@tmuxy-group-panes` | comma-separated pane ids, e.g. `%4,%6,%7` | pane-group windows |

### `@tmuxy-float-parent` semantics

A single field with a single type — always a **window id** (`@<n>`) — interpreted by `@tmuxy-window-type`:

- on a `float` window: the window the float was launched from (focus returns there on close)
- on a `float-backdrop` window: the float window it sits behind

There is no separate `@tmuxy-float-backdrop-of`. The window-type disambiguates.

### Float window naming

Drawer direction, backdrop style, and the no-header flag move out of the window name and into dedicated options. Float window names become user-facing labels (e.g. the running command, or a user-set title) instead of `__float_5_drawer_left_bg_blur`.

### Pane-group naming

Group membership lives in `@tmuxy-group-panes`. The window name no longer encodes pane ids — it becomes a user-facing label (default `group`).

## Optimistic client-side updates

Every tab/pane/group/float operation goes through the existing optimistic pipeline in `packages/tmuxy-ui/src/tmux/store/`:

- single-step ops use `TmuxOp` + `predict` + `reconcile` (see `tmux/store/ops.ts` and `tmux/store/TmuxStore.ts:161-241`)
- multi-step ops use `Effect` programs in `tmux/effect/compoundOps.ts` with structured rollback

No tab or pane operation is allowed to be a fire-and-forget `RawCommand` after this migration — every mutation predicts a local patch, dispatches the tmux command, and reconciles against the next server snapshot.

### New single-step ops

Added to the `TmuxOp` union in `tmux/store/types.ts` with corresponding `predict` / `reconcile` in `tmux/store/ops.ts` and command serialization in `tmux/store/parseCommand.ts`:

| Op | Predict (local patch) | Reconcile verdict |
|---|---|---|
| `SetWindowType` | sets `windowType` (and any metadata fields) on the target window in `derived` | matched when server snapshot reports the same `windowType` |
| `UnsetWindowType` | clears `windowType` and metadata on the target window (window becomes foreign) | matched when server snapshot reports the window as untagged |
| `KillWindow` | removes the window from `derived`, advances `activeWindowId` to a sibling | matched when the window is absent from the server snapshot |
| `RenameWindow` | rewrites `name` in `derived` | matched when server snapshot reports the new name |
| `KillPane` | removes pane from `derived`, recomputes adjacency | matched when pane is absent from server snapshot |
| `ResizePane` | updates pane geometry in `derived` (best-effort prediction) | matched when server geometry is within tolerance |

These follow the same MRU-claim pattern as `Split` / `NewWindow` for deduplication when multiple ops of the same type are in flight.

### New compound ops

Added to `tmux/effect/compoundOps.ts`:

- **`createFloat({ parentWindowId, parentPaneId, width, height, drawer?, bg?, noheader?, cmd? })`** — creates float window via `splitw + breakp`, sets `@tmuxy-window-type=float` and all metadata, optionally creates a `float-backdrop` sibling window with its own tag. Rollback on any step kills any windows already created.
- **`closeFloat(windowId)`** — kills the float and, if present, its backdrop (located by scanning windows for `@tmuxy-window-type=float-backdrop` with `@tmuxy-float-parent=<windowId>`). Tagging is read from `derived`, not by re-querying tmux.
- **`createGroup({ paneIds })`** — moves the panes into a fresh window, sets `@tmuxy-window-type=group` and `@tmuxy-group-panes`. Rollback returns panes to their original windows.
- **`closeGroup(windowId)`** — moves group panes back to their origins (recorded in op meta), kills the now-empty group window. Rollback restores group state.
- **`adoptWindow(windowId)`** — single-step but exposed as a compound for symmetry with the CLI command `tmuxy tab adopt`. Wraps `SetWindowType { windowId, type: 'tab' }`.

Compound ops dispatch their constituent single-step ops through `TmuxStore.dispatch()` so each sub-op gets its own pending entry and rollback. The outer `Effect` only orchestrates ordering and final-state cleanup.

## Migration steps

Land in this order. Each step is independently reviewable and keeps the tree green.

### A. Read path (additive, no behavior change)

1. Extend the `list-windows` format string in `packages/tmuxy-core/src/control_mode/monitor.rs:201,453,725` to fetch the new options:
   ```
   #{window_id},#{window_index},#{window_name},#{window_active},#{@tmuxy-window-type},#{@tmuxy-float-parent},#{@tmuxy-float-width},#{@tmuxy-float-height},#{@tmuxy-float-drawer},#{@tmuxy-float-bg},#{@tmuxy-float-noheader},#{@tmuxy-group-panes}
   ```
2. In `packages/tmuxy-core/src/control_mode/state.rs:521,529`, parse the new fields into `WindowState`. Keep `is_float_window_name` / `parse_pane_group_window_name` as a **fallback** for any window where `@tmuxy-window-type` is empty but the name still matches the old prefix — guarantees nothing disappears before step D runs.
3. Update `TmuxWindow` in `packages/tmuxy-core/src/lib.rs:296` and `packages/tmuxy-ui/src/tmux/types.ts:65` to carry `windowType: 'tab' | 'float' | 'float-backdrop' | 'group' | null` and the metadata fields directly. `isPaneGroupWindow` / `isFloatWindow` derive from `windowType` — keep them as getters during the transition.

### B. Write path

1. Shell scripts under `bin/tmuxy/`: every script that creates a window now sets the options immediately after creation, via `tmux set-option -w -t <id> @tmuxy-window-type <kind>` plus metadata. Scripts touched: `float-create`, `pane-group-add`, `pane-group-close`, `tab-create`, anything in `_lib` that builds window names.
2. Stop building encoded names — `build_float_name` and `build_group_name` go away. Window names default to user-facing labels.
3. Rust-side window creation (server-driven flows, if any) writes the same options.
4. Frontend client: `tmux/effect/compoundOps.ts` gains `createFloat` / `createGroup` / `closeFloat` / `closeGroup` / `adoptWindow` (see "New compound ops" above). All UI-initiated window creation routes through these.

### C. Frontend cutover

1. Replace name-prefix parsing in `packages/tmuxy-ui/src/machines/app/helpers.ts:208-237` (`parseFloatWindowPaneId`) and `groupState.ts:19,51` (`isGroupWindow`) with direct reads of `window.windowType` and `window.floatParent` / `window.groupPanes` from `TmuxWindow`.
2. Update filters in `selectors.ts:247`, `WindowTabs.tsx:55`, `AppMenu.tsx:49`, `appMachine.ts:130` to use `w.windowType === 'tab'` (or `w.windowType != null` where the test was "is tmuxy-managed").
3. Replace hardcoded `__float_session` / `__float_connect` names in `actions/groupsAndFloats.ts:36,55` with semantically-named windows that get tagged via `createFloat`.
4. Demo engine (`packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts`) carries `windowType` on its in-memory windows and drops all `startsWith('__group_')` / `startsWith('__float_')` checks (lines 117, 141-142, 177-178, 376, 386, 786, 801, 1019-1035).

### D. One-time migration (runs at server startup, idempotent)

Implemented as a function called once per attached session immediately after the first `list-windows` snapshot is received in `control_mode/monitor.rs`:

```
for each window in session:
    if @tmuxy-window-type already set: skip
    elif name matches __float_<n>(_drawer_<dir>)?(_bg_<style>)?(_noheader)?:
        set @tmuxy-window-type=float
        set @tmuxy-float-parent, drawer, bg, noheader from name suffixes
        (parent pane id is migrated to parent window id by looking up the pane's window)
        rename window to a user-friendly default (e.g. the command name)
    elif name matches __group_<panes>:
        set @tmuxy-window-type=group
        set @tmuxy-group-panes from name
        rename window to "group"
    else:
        set @tmuxy-window-type=tab   # auto-adopt — every visible window the day of upgrade stays visible
```

Re-running is a no-op because each branch short-circuits on the first line. Users can `tmuxy tab adopt @<id>` later to claim any window they intentionally left foreign.

### E. Cleanup

Once step D has shipped and bake time has passed (one or two version cuts is plenty; CLAUDE.md says no backwards-compat shim is required for this project):

- delete `is_float_window_name` and `parse_pane_group_window_name` in `tmuxy-core/src/lib.rs:316-340` and their tests at `:785-814`
- delete all `__group_*` / `__float_*` filter glob patterns in `bin/tmuxy/_lib:89,132` and shell scripts
- delete the demo engine's name-prefix branches in `DemoTmux.ts:117,141-142,177-178,786,801,1019-1035`
- delete `isPaneGroupWindow` / `isFloatWindow` getters once nothing outside the type definition reads them

### F. Tests

- Update `tests/helpers/consistency.js:47` and `tests/helpers/snapshot-compare.js:167-285` to filter and categorize on `w.windowType`, not name patterns.
- Add new tests covering:
  - a window without `@tmuxy-window-type` is absent from `selectVisibleWindows` and from the React tab strip
  - `tmuxy tab adopt @<id>` makes a foreign window visible
  - the one-time migration converts an `__float_*` window to a tagged float with metadata intact
  - `SetWindowType` is optimistic: dispatching the op flips the tab strip before the server snapshot arrives, and a server snapshot lacking the tag rolls back the pending op
  - `closeFloat` removes both the float and its backdrop optimistically and reconciles cleanly when the next snapshot arrives missing both

## Risks and open questions

1. **Foreign-window adoption UX.** Step D auto-tags every existing window as `tab` on first run, so no user loses anything at upgrade time. New windows created outside tmuxy (raw `tmux neww`, IDE plugins) stay foreign, which is the goal — but it's a UX change worth documenting in `docs/TMUX.md`. The `tmuxy tab adopt @<id>` CLI command (and a UI affordance under the foreign-window menu) gives users an explicit escape hatch.
2. **User-option persistence.** Window user-options survive `rename-window` and `move-window` between sessions — verified against the existing `@float_parent` usage. They do not survive `kill-window` (irrelevant) or being recreated by a different process (`neww` from a shell starts untagged, which is the intended foreign behavior).
3. **Backdrop linkage.** `@tmuxy-float-parent` on a backdrop points to a window id, which is stable for the window's lifetime in tmux. Safe.
4. **Float drawer/bg/noheader variants.** The current naming scheme encodes `_drawer_<top|bottom|left|right>`, `_bg_<blur|dim|...>`, and `_noheader`. Confirm in `bin/tmuxy/float-create:60-68` that no other suffix variants exist before deleting the name parser — there's a risk of missing an undocumented combo.
5. **Demo engine parity.** The demo engine has no tmux to set options on, so it stores `windowType` directly on its in-memory window objects. The migration step is a no-op in the demo. Make sure the demo and real adapters expose the same `TmuxWindow` shape so consumers don't branch.
6. **Optimistic predictions for new ops.** `KillWindow` / `KillPane` predictions need to compute the next active window/pane the same way tmux does (most-recently-used in the same session). The MRU order tracking already exists in `TmuxStore`'s predict context — reuse it; don't reinvent.
