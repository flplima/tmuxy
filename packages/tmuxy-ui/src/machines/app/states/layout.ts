/**
 * layout state — parallel state for panes, windows, and focus.
 *
 * Owns context fields: panes, windows, activeWindowId, activePaneId,
 * paneActivationOrder, lastActivePaneByWindow, paneKeyOverrides,
 * lastLayoutCommandTime, drag, resize,
 * resizeActive, suppressLayoutTransition.
 *
 * Optimistic operations no longer live here — they're owned by the
 * Tier-3 TmuxStore (`src/tmux/store/`). The TMUX_MODEL_UPDATE handler
 * mirrors the store's `derived` snapshot into context, so this state
 * stays a passive view of the model.
 *
 * Migrated events (these spread into states.idle.on):
 *   SEND_KEYS, CLOSE_PANE, ZOOM_PANE, WRITE_TO_PANE, SELECT_TAB,
 *   KEY_PRESS, RESIZE_STATE_UPDATE, RESIZE_COMPLETED, RESIZE_ERROR,
 *   DRAG_STATE_UPDATE, DRAG_ERROR.
 *
 * Cross-cutting / orchestrator events remain inline in appMachine.ts —
 * see the JSDoc on layoutActions for the explicit list.
 */

export const layoutState = {
  on: {
    SEND_KEYS: { actions: 'layout_sendKeysToTmux' },
    CLOSE_PANE: { actions: 'layout_closePane' },
    ZOOM_PANE: { actions: 'layout_zoomPane' },
    WRITE_TO_PANE: { actions: 'layout_writeToPane' },
    SELECT_TAB: { actions: 'layout_selectTab' },
    KEY_PRESS: { actions: 'layout_forwardKeyToDragResize' },
    RESIZE_STATE_UPDATE: { actions: 'layout_applyResizeState' },
    RESIZE_COMPLETED: { actions: 'layout_resizeCompleted' },
    RESIZE_ERROR: { actions: 'layout_resizeError' },
    DRAG_STATE_UPDATE: { actions: 'layout_dragStateUpdate' },
    DRAG_ERROR: { actions: 'layout_dragError' },
  },
} as const;

