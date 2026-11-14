/**
 * The context's appearance options as the config sets them, and the values
 * they take before a config has said (or on an adapter that has none),
 * tmuxy.defaults.conf's, for the initial context and for every
 * THEME_SETTINGS_RECEIVED.
 */

import type { Appearance } from '../../domain/wire';
import { DEFAULT_APPEARANCE as D } from '../../domain/tmuxyConstants.gen';
import type { AppMachineContext } from '../types/context';

export type AppearancePrefs = Pick<
  AppMachineContext,
  | 'animationsAllowed'
  | 'cursorBlink'
  | 'sendAsk'
  | 'confirmClose'
  | 'notifyAllowed'
  | 'transparency'
  | 'tabOverviewCols'
  | 'gestureFlags'
  | 'nativeMenus'
>;

export function appearancePrefs(appearance: Appearance | undefined): AppearancePrefs {
  return {
    animationsAllowed: appearance?.animations ?? D.animations,
    cursorBlink: appearance?.cursorBlink ?? D.cursorBlink,
    sendAsk: appearance?.sendAsk ?? D.sendAsk,
    confirmClose: appearance?.confirmClose ?? D.confirmClose,
    notifyAllowed: appearance?.notify ?? D.notify,
    transparency: appearance?.transparency ?? D.transparency,
    tabOverviewCols: appearance?.tabOverviewCols ?? D.tabOverviewCols,
    gestureFlags: {
      swipeTabs: appearance?.gestureSwipeTabs ?? D.gestureSwipeTabs,
      pinchZoom: appearance?.gesturePinchZoom ?? D.gesturePinchZoom,
      pinchOverview: appearance?.gesturePinchOverview ?? D.gesturePinchOverview,
    },
    nativeMenus: appearance?.nativeMenus ?? D.nativeMenus,
  };
}
