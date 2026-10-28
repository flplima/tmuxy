/**
 * phone state — what only the phone layout has (utils/phoneLayout.ts).
 *
 * Owns context fields: phoneZoom, phoneBottomView, phoneDockSizeSent.
 *
 * Every event here is spread into the machine root: the zoom is drawn by the
 * client alone, and the bottom view's dock reaches tmux through the same
 * sidebar ops the desktop's right column uses.
 */

export const phoneGlobalEvents = {
  TOGGLE_PHONE_ZOOM: { actions: 'phone_toggleZoom' },
  SET_PHONE_BOTTOM_VIEW: { actions: 'phone_setBottomView' },
  SET_PHONE_DOCK_SIZE: { actions: 'phone_setDockSize' },
} as const;
