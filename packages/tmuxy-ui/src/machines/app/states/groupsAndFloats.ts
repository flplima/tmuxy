/**
 * groupsAndFloats state — parallel state for pane groups, float panes and the
 * two sidebar columns.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId,
 * leftSidebarOpen, leftSidebarFocused, rightSidebarOpen, rightSidebarFocused.
 *
 * - groupsAndFloatsGlobalEvents: spread into machine root on:
 *   (OPEN_SESSION_FLOAT, OPEN_CONNECT_FLOAT, TOGGLE_LEFT_SIDEBAR — pure
 *    side-effect dispatches that work in any state).
 *
 * - groupsAndFloatsIdleEvents: spread into states.idle.on
 *   (CLOSE_FLOAT, CLOSE_TOP_FLOAT, the left sidebar's focus events, and every
 *    right-sidebar event — the dock's toggle can have to CREATE its tmux
 *    window, so unlike the left column it needs a live connection).
 *
 * SELECT_PANE_GROUP_TAB stays inline in appMachine.ts (cross-cutting with
 * layout). It will be revisited during the layout migration.
 */

export const groupsAndFloatsGlobalEvents = {
  OPEN_SESSION_FLOAT: { actions: 'groupsAndFloats_openSessionFloat' },
  OPEN_CONNECT_FLOAT: { actions: 'groupsAndFloats_openConnectFloat' },
  TOGGLE_LEFT_SIDEBAR: { actions: 'groupsAndFloats_toggleLeftSidebar' },
} as const;

export const groupsAndFloatsIdleEvents = {
  CLOSE_FLOAT: { actions: 'groupsAndFloats_closeFloat' },
  CLOSE_TOP_FLOAT: { actions: 'groupsAndFloats_closeTopFloat' },
  FOCUS_LEFT_SIDEBAR: { actions: 'groupsAndFloats_focusLeftSidebar' },
  BLUR_LEFT_SIDEBAR: { actions: 'groupsAndFloats_blurLeftSidebar' },
  TOGGLE_RIGHT_SIDEBAR: { actions: 'groupsAndFloats_toggleRightSidebar' },
  FOCUS_RIGHT_SIDEBAR: { actions: 'groupsAndFloats_focusRightSidebar' },
  BLUR_RIGHT_SIDEBAR: { actions: 'groupsAndFloats_blurRightSidebar' },
} as const;
