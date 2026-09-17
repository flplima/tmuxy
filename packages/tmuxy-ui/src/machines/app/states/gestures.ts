/**
 * gestures state - trackpad slides and pinches (see actors/gestureActor.ts).
 *
 * Owns context fields: gesture.
 *
 * Every event here is spread into the machine root: a gesture only draws on
 * the pane area, and it commits through events (SELECT_TAB, ZOOM_PANE,
 * TOGGLE_TAB_OVERVIEW, TAB_OVERVIEW_ACTIVATE) that the states handling them
 * already gate on a live connection.
 *
 * Action implementations live in ../actions/gestures.ts.
 */

export const gesturesGlobalEvents = {
  GESTURE_PINCH: { actions: 'gestures_pinch' },
  GESTURE_PINCH_END: { actions: 'gestures_pinchEnd' },
  GESTURE_SWIPE: { actions: 'gestures_swipe' },
  GESTURE_SWIPE_END: { actions: 'gestures_swipeEnd' },
  GESTURE_SETTLE: { actions: 'gestures_settle' },
} as const;
