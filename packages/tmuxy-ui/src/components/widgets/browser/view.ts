/**
 * The browser widget's view, derived from machine state.
 *
 * `browserStates[paneId]` holds only what the *user* did — the zoom chosen,
 * the refreshes asked for, and where they have navigated. The pane's own
 * source is never stored: it is what the widget marker declares, which arrives
 * with every render. So a pane nobody has touched carries no state at all and
 * shows exactly what it was pointed at.
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
  /** The page currently shown: where the pane has been navigated, or its source. */
  url: string;
  /** What the pane's widget marker declares — the record's identity. */
  source: string;
  zoom: number;
  reloadNonce: number;
  /** Whether there is anywhere to go back to / forward to. */
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * The `<title>` of the page showing, when it could be read — empty for a
   * cross-origin site, whose document is not the app's to read. Only ever the
   * title of THIS url: a stale one from the page before would be worse than
   * none, since the pane's tab is how the user tells panes apart.
   */
  pageTitle: string;
}

export function browserView(state: BrowserPaneState | undefined, lines: string[]): BrowserView {
  const source = parseSource(lines);
  // A record from a browser that used to run in this pane is not this
  // browser's — the pane id survives closing one and opening another.
  const own = state?.source === source ? state : undefined;
  const url = own?.history[own.historyIndex] ?? source;
  return {
    url,
    source,
    zoom: own?.zoom ?? 1,
    reloadNonce: own?.reloadNonce ?? 0,
    canGoBack: (own?.historyIndex ?? 0) > 0,
    canGoForward: own ? own.historyIndex < own.history.length - 1 : false,
    pageTitle: own?.pageTitle?.url === url ? own.pageTitle.title : '',
  };
}

/** `host:port` — which reads exactly like `scheme:` and is not one. */
const HOST_PORT = /^[a-z0-9][a-z0-9.-]*:\d+(?:[/?#]|$)/i;
/** A scheme the address already carries: `https:`, `file:`, `data:`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Hosts served over plain http far more often than not. */
const LOOPBACK = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|[a-z0-9-]+\.localhost)(?::|\/|$)/i;

/**
 * What a typed address means.
 *
 * Trimmed, and given a scheme when it reads like a bare host — `example.com`
 * and `localhost:3000` are what people type, and an address bar that took them
 * literally would look for a relative file of that name. Anything already
 * carrying a scheme (`https:`, `file:`, `data:`) or naming a path is left
 * exactly as written: this widget shows local files too, and rewriting a path
 * into a URL would break the case the app is most often pointed at.
 *
 * Two shapes need telling apart by hand. `localhost:3000` matches the scheme
 * pattern (`localhost` reads as a scheme and `3000` as the rest) but is a host
 * and a port, so a port of digits is checked for first. And a loopback host
 * gets `http`, not `https`: a dev server on port 3000 is almost never serving
 * TLS, and a real browser's "try https, fall back" is not available to an
 * iframe — the failure would just be a blank pane.
 *
 * Returns '' for an address with nothing in it, which is the signal to do
 * nothing rather than navigate to a blank page.
 */
export function normalizeAddress(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  const bareHost = HOST_PORT.test(value) || !HAS_SCHEME.test(value);
  if (!bareHost) return value;
  if (value.startsWith('/') || value.startsWith('~') || value.startsWith('.')) return value;
  return `${LOOPBACK.test(value) ? 'http' : 'https'}://${value}`;
}

/** Same view, read from machine context — for the menu, which has no props. */
export function selectBrowserView(
  context: AppMachineContext,
  paneId: string,
  lines: string[],
): BrowserView {
  return browserView(context.browserStates[paneId], lines);
}
