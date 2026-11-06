/**
 * layout state — the `on` slice for panes, windows, and focus.
 *
 * Optimistic operations are owned by the TmuxStore (`src/infra/store/TmuxStore.ts`, its model in `src/domain/store/`).
 * The TMUX_MODEL_UPDATE handler mirrors the store's `derived` snapshot into
 * context, so this state stays a passive view of the model.
 */
export const layoutState = {
  on: {
    SEND_KEYS: { actions: 'layout_sendKeysToTmux' },
    CLOSE_PANE: { actions: 'layout_closePane' },
    ZOOM_PANE: { actions: 'layout_zoomPane' },
    WRITE_TO_PANE: { actions: 'layout_writeToPane' },
    SELECT_TAB: { actions: 'layout_selectTab' },
    SELECT_PANE: { actions: 'layout_selectPane' },
    DRAG_START: { actions: 'layout_dragStart' },
    RESIZE_START: { actions: 'layout_resizeStart' },
    MOVE_PANE_TO_TAB: { actions: 'layout_movePaneToTab' },
    KEY_PRESS: { actions: 'layout_forwardKeyToDragResize' },
    RESIZE_STATE_UPDATE: { actions: 'layout_applyResizeState' },
    RESIZE_COMPLETED: { actions: 'layout_resizeCompleted' },
    DRAG_STATE_UPDATE: { actions: 'layout_dragStateUpdate' },
  },
} as const;

export const layoutGlobalEvents = {
  SUPPRESS_ANIMATIONS: { actions: 'layout_suppressAnimations' },
  ANIMATIONS_SETTLED: { actions: 'layout_enableAnimations' },
} as const;
