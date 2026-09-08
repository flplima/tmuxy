/**
 * The browser widget's history and zoom, derived from machine state.
 *
 * `browserStates[paneId]` holds only what the *user* did — the pages navigated
 * to and the zoom chosen. The first history entry is never stored: it is the
 * source the pane's widget marker declares, which the machine cannot see and
 * does not need to, since it arrives with every render. That keeps the machine
 * free of a seeding round-trip on mount (there is nothing to seed) and makes a
 * pane that has only ever shown its opening page carry no state at all.
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
  /** The page the pane's widget marker declares — history entry 0. */
  source: string;
  /** The source currently shown. */
  url: string;
  /** Full history, opening source first. */
  entries: string[];
  index: number;
  zoom: number;
  reloadNonce: number;
  canGoBack: boolean;
  canGoForward: boolean;
}

export function browserView(state: BrowserPaneState | undefined, lines: string[]): BrowserView {
  const source = parseSource(lines);
  // A record from a browser that used to run in this pane is not this
  // browser's history — the pane id survives closing one and opening another.
  const own = state?.source === source ? state : undefined;
  const entries = [source, ...(own?.pushed ?? [])];
  const index = Math.min(own?.index ?? 0, entries.length - 1);
  return {
    source,
    url: entries[index] ?? '',
    entries,
    index,
    zoom: own?.zoom ?? 1,
    reloadNonce: own?.reloadNonce ?? 0,
    canGoBack: index > 0,
    canGoForward: index < entries.length - 1,
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
