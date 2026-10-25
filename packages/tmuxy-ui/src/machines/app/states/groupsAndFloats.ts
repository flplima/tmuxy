/**
 * groupsAndFloats state — the `on` slice for pane groups and float panes.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId.
 *
 * SELECT_PANE_GROUP_TAB lives inline in appMachine.ts (cross-cutting with
 * layout).
 */

export const groupsAndFloatsGlobalEvents = {
  SYNC_FLOAT_FOCUS: { actions: 'groupsAndFloats_syncFloatFocus' },
  OPEN_CONNECT_FLOAT: {
    actions: 'groupsAndFloats_openConnectFloat',
  },
} as const;

export const groupsAndFloatsIdleEvents = {
  CLOSE_FLOAT: { actions: 'groupsAndFloats_closeFloat' },
  CLOSE_TOP_FLOAT: { actions: 'groupsAndFloats_closeTopFloat' },
} as const;
