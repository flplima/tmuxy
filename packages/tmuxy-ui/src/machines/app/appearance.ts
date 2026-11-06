/**
 * The context's appearance options as the config sets them, and the values
 * they take before a config has said (or on an adapter that has none): the
 * one place those defaults are written, for the initial context and for
 * every THEME_SETTINGS_RECEIVED. They match tmuxy.defaults.conf's.
 */

import type { Appearance } from '../../domain/wire';
import type { AppMachineContext } from '../types/context';

export type AppearancePrefs = Pick<
  AppMachineContext,
  | 'animationsAllowed'
  | 'cursorBlink'
  | 'sendAsk'
  | 'notifyAllowed'
  | 'transparency'
  | 'tabOverviewCols'
  | 'gestureFlags'
  | 'nativeMenus'
>;

export function appearancePrefs(appearance: Appearance | undefined): AppearancePrefs {
  return {
    animationsAllowed: appearance?.animations ?? true,
    cursorBlink: appearance?.cursorBlink ?? true,
    sendAsk: appearance?.sendAsk ?? true,
    notifyAllowed: appearance?.notify ?? true,
    transparency: appearance?.transparency ?? true,
    tabOverviewCols: appearance?.tabOverviewCols ?? 3,
    gestureFlags: {
      swipeTabs: appearance?.gestureSwipeTabs ?? true,
      pinchZoom: appearance?.gesturePinchZoom ?? true,
      pinchOverview: appearance?.gesturePinchOverview ?? true,
    },
    nativeMenus: appearance?.nativeMenus ?? true,
  };
}
