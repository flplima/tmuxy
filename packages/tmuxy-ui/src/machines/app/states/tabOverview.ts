/**
 * tabOverview state — the "all tabs" view over the pane area.
 *
 * Owns context fields: tabOverviewOpen, tabOverviewSelected, renamingTabId.
 *
 * Every event here is spread into the machine root: opening the overview,
 * moving its cursor and picking a slot are pure client-side dispatches, and
 * the two that reach tmux (REORDER_TAB, CLOSE_TAB) target a window by id, so
 * they are valid in any connected state.
 */

export const tabOverviewGlobalEvents = {
  TOGGLE_TAB_OVERVIEW: { actions: 'tabOverview_toggle' },
  CLOSE_TAB_OVERVIEW: { actions: 'tabOverview_close' },
  TAB_OVERVIEW_MOVE: { actions: 'tabOverview_move' },
  TAB_OVERVIEW_ACTIVATE: { actions: 'tabOverview_activate' },
  SELECT_TAB_BY_POSITION: { actions: 'tabOverview_selectByPosition' },
  REORDER_TAB: { actions: 'tabOverview_reorder' },
  MOVE_ACTIVE_TAB: { actions: 'tabOverview_moveActive' },
  CLOSE_TAB: { actions: 'tabOverview_closeTab' },
  RENAME_ACTIVE_TAB: { actions: 'tabOverview_rename' },
  RENAME_TAB: { actions: 'tabOverview_rename' },
  TAB_RENAME_END: { actions: 'tabOverview_renameEnd' },
  TOGGLE_STACKED_PANES: { actions: 'tabOverview_toggleStacked' },
} as const;
