# Window Tags

tmuxy marks the special windows it manages using per-window tmux user-options under the `@tmuxy-*` namespace. The discriminator option, `@tmuxy-window-type`, replaced the legacy `__float_*` / `__group_*` name-prefix conventions.

This document describes the window-tag system: the canonical reference for the schema and how the frontend, backend, and shell scripts consume it.

## Filtering rule

**Tabs carry no marker.** Any window in the attached session that is *not* tagged `float`, `float-backdrop`, or `sidebar` is a tab — including foreign windows a user creates with a raw `tmux neww`, which simply appear as tabs. Only the non-tab chrome windows are tagged, and only those are filtered out of the tab strip. Window names are purely cosmetic and never used to infer type.

This means the attached session's window list maps 1:1 to the tab strip (minus any open floats), so a native `tmux attach` and tmuxy agree on what the tabs are. (Hidden pane-group members live in a separate stash session — see below — so they are not windows in the attached session at all.)

## Schema

Window options are scoped per window (`set-option -w -t <window-id>`). The one
pane option (`@tmuxy-group-id`) is scoped per pane (`set-option -p -t <pane-id>`).

| Option | Scope | Values | Set on |
|---|---|---|---|
| `@tmuxy-window-type` | window | `float` \| `float-backdrop` \| `sidebar` | non-tab chrome windows only (tabs are untagged) |
| `@tmuxy-float-parent` | window | `@<window-id>` | floats and float-backdrops |
| `@tmuxy-float-width` | window | integer or percentage | floats |
| `@tmuxy-float-height` | window | integer or percentage | floats |
| `@tmuxy-float-drawer` | window | `top` \| `bottom` \| `left` \| `right` \| unset | drawer-style floats |
| `@tmuxy-float-bg` | window | `blur` \| `dim` \| unset | floats with a backdrop |
| `@tmuxy-float-noheader` | window | `1` \| unset | floats that hide the header chrome |
| `@tmuxy-group-id` | pane | `g<n>`, e.g. `g5` | every member of a pane group |

### Pane groups and the stash session

Pane groups are **not** a window type. A group is a set of panes that share a
`@tmuxy-group-id` pane option (minted from the anchor pane id, e.g. `%5` → `g5`;
unique for the group's life because tmux never reuses pane ids). The **visible**
member is an ordinary pane in the attached session; the **hidden** members are
parked one-per-window in a dedicated session, `__tmuxy_stash`, which is never
attached and never appears in any session picker or tree. Switching tabs is a
cross-session `swap-pane` — the pane options follow the panes, so membership is
maintained without any per-window bookkeeping.

The backend enumerates hidden members with a separate `list-panes` targeting the
stash session (rows prefixed with a `stashmember,` sentinel) and emits them as
lightweight pane stubs carrying `group_id`; the frontend rebuilds each group by
grouping panes on `group_id`. A stub whose group has no visible member left is an
orphan — always pruned from the emitted state (so it never renders as a phantom
tab) and reaped from the stash by `gc_groups` on the next group operation.

This replaces the earlier model where a group was a hidden `@tmuxy-window-type=group`
window holding the members plus a `@tmuxy-group-panes` membership list. Keeping
hidden members out of the attached session means a native `tmux attach` sees only
the user's real tabs, and the attached session's window list maps 1:1 to the tab
strip.

### `@tmuxy-float-parent` semantics

A single field with a single type — always a **window id** (`@<n>`) — interpreted by `@tmuxy-window-type`:

- on a `float` window: the window the float was launched from (focus returns there on close)
- on a `float-backdrop` window: the float window it sits behind

There is no separate `@tmuxy-float-backdrop-of`. The window-type disambiguates.

### Float window naming

Drawer direction, backdrop style, and the no-header flag move out of the window name and into dedicated options. Float window names become user-facing labels (e.g. the running command, or a user-set title) instead of `__float_5_drawer_left_bg_blur`.

### Pane-group naming

Group membership lives in the per-pane `@tmuxy-group-id` option (see "Pane groups and the stash session" above). There is no group window and no encoded name.

## How the tags are consumed

The backend (`tmuxy-core`) reads the options off `list-windows` and emits each window's `windowType` on the wire, defaulting an untagged window to `tab` (see `WindowState::to_tmux_window`). The setup pass (`collect_window_tag_commands` in `control_mode/state.rs`) re-tags a float/sidebar window whose option went missing and enforces `pane-border-status top` per tab window (session-level `set` is not inherited by windows), but it never writes a `tab` marker.

The frontend filters on `windowType`:

- `selectVisibleWindows` (`packages/tmuxy-ui/src/machines/selectors.ts`) keeps only `windowType === 'tab'` windows for the tab strip.
- the sidebar tree (`machines/actors/serversActor.ts`) hides `float` / `float-backdrop` / `sidebar` windows and the `__tmuxy_stash` session; everything else (including untagged foreign windows) shows as a tab.
- floats are rebuilt from `windowType === 'float'` windows and their `@tmuxy-float-*` metadata (`machines/app/helpers.ts`).

Window/pane mutations go through the optimistic pipeline in `packages/tmuxy-ui/src/tmux/store/` — each op predicts a local patch, dispatches the tmux command, and reconciles against the next server snapshot (`ops.ts`, `TmuxStore.ts`); float compound flows and rollback live in `tmux/effect/`.

## History

The `@tmuxy-window-type` option replaced the legacy `__float_*` / `__group_*` name-prefix conventions. Two later changes reshaped the scheme: pane groups moved from a `group` window type to a per-pane `@tmuxy-group-id` plus the `__tmuxy_stash` session (see [TMUX.md](TMUX.md) "Group State and the Stash Session"), and the `tab` marker was dropped entirely so an untagged window is a tab. Only `float`, `float-backdrop`, and `sidebar` windows carry a type today.
6. **Optimistic predictions for new ops.** `KillWindow` / `KillPane` predictions need to compute the next active window/pane the same way tmux does (most-recently-used in the same session). The MRU order tracking already exists in `TmuxStore`'s predict context — reuse it; don't reinvent.
