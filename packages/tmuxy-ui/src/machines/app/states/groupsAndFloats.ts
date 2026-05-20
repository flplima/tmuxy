/**
 * groupsAndFloats state — parallel state for pane groups and float panes.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId,
 * groupSwitchDimOverrides.
 *
 * - groupsAndFloatsGlobalEvents: spread into machine root on:
 *   (OPEN_SESSION_FLOAT, OPEN_CONNECT_FLOAT — pure side-effect dispatches
 *    that work in any state).
 *
 * - groupsAndFloatsIdleEvents: spread into states.idle.on
 *   (CLOSE_FLOAT, CLOSE_TOP_FLOAT, CLEAR_GROUP_SWITCH_OVERRIDE — require
 *    a live connection to mutate float/group state).
 *
 * SELECT_PANE_GROUP_TAB stays inline in appMachine.ts (cross-cutting with
 * layout). It will be revisited during the layout migration.
 */

export const groupsAndFloatsGlobalEvents = {
  OPEN_SESSION_FLOAT: { actions: 'groupsAndFloats_openSessionFloat' },
  OPEN_CONNECT_FLOAT: { actions: 'groupsAndFloats_openConnectFloat' },
} as const;

export const groupsAndFloatsIdleEvents = {
  CLOSE_FLOAT: { actions: 'groupsAndFloats_closeFloat' },
  CLOSE_TOP_FLOAT: { actions: 'groupsAndFloats_closeTopFloat' },
  CLEAR_GROUP_SWITCH_OVERRIDE: { actions: 'groupsAndFloats_clearGroupSwitchOverride' },
} as const;

// Back-compat alias for the index.ts re-export contract.
export const groupsAndFloatsState = {
  on: { ...groupsAndFloatsGlobalEvents, ...groupsAndFloatsIdleEvents },
} as const;

export const groupsAndFloatsSelectors = {};
