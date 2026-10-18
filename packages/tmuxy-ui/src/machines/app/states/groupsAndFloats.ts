/**
 * groupsAndFloats state — the `on` slice for pane groups and float panes.
 *
 * Owns context fields: paneGroups, floatPanes, focusedFloatPaneId.
 *
 * SELECT_PANE_GROUP_TAB lives inline in appMachine.ts (cross-cutting with
 * layout).
 */

import { notReadOnly } from '../readOnlyGuard';

export const groupsAndFloatsGlobalEvents = {
  SYNC_FLOAT_FOCUS: { actions: 'groupsAndFloats_syncFloatFocus' },
  OPEN_CONNECT_FLOAT: {
    guard: notReadOnly,
    actions: 'groupsAndFloats_openConnectFloat',
  },
} as const;

export const groupsAndFloatsIdleEvents = {
  CLOSE_FLOAT: { guard: notReadOnly, actions: 'groupsAndFloats_closeFloat' },
  CLOSE_TOP_FLOAT: { guard: notReadOnly, actions: 'groupsAndFloats_closeTopFloat' },
} as const;
