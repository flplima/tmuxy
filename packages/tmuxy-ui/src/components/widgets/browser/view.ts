/**
 * The browser widget's zoom and refresh, derived from machine state.
 *
 * `browserStates[paneId]` holds only what the *user* did — the zoom chosen and
 * the refreshes asked for. The page itself is never stored: it is the source
 * the pane's widget marker declares, which the machine cannot see and does not
 * need to, since it arrives with every render. So a pane nobody has zoomed or
 * refreshed carries no state at all.
 */

import type { AppMachineContext, BrowserPaneState } from '../../../machines/types';
import { parseSource } from './source';

/** Zoom bounds. Wider than a real browser's ladder; a pane can be very small. */
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.1;

export function clampZoom(zoom: number): number {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) * 100) / 100;
}

export interface BrowserView {
  /** The page the pane's widget marker declares, and the one shown. */
  url: string;
  zoom: number;
  reloadNonce: number;
}

export function browserView(state: BrowserPaneState | undefined, lines: string[]): BrowserView {
  const url = parseSource(lines);
  // A record from a browser that used to run in this pane is not this
  // browser's — the pane id survives closing one and opening another.
  const own = state?.source === url ? state : undefined;
  return {
    url,
    zoom: own?.zoom ?? 1,
    reloadNonce: own?.reloadNonce ?? 0,
  };
}

/** Same view, read from machine context — for the menu, which has no props. */
export function selectBrowserView(
  context: AppMachineContext,
  paneId: string,
  lines: string[],
): BrowserView {
  return browserView(context.browserStates[paneId], lines);
}
