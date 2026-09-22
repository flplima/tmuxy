/**
 * The `browser` widget's contributions to the pane chrome it does not own:
 * the tab icon and title, its section of the ⋮ pane menu, and the keys it
 * claims. See `../index.ts` for the WidgetDefinition contract.
 */

import type { WidgetDefinition, WidgetMenuItem } from '../index';
import { TmuxyBrowser } from './TmuxyBrowser';
import { selectBrowserView, ZOOM_STEP } from './view';
import { browserTitle, parseSource } from './source';

/**  nf-fa-globe — a browser pane reads as a globe rather than a shell. */
const GLOBE_ICON = '\uf0ac';

export const browserWidget: WidgetDefinition = {
  component: TmuxyBrowser,
  icon: GLOBE_ICON,

  // The page's own `<title>` where it could be read, the address otherwise —
  // the same order of preference a browser tab uses. See `BROWSER_PAGE_TITLE`
  // for why a cross-origin site has no title to offer.
  selectTitle: (context, paneId, lines) => {
    const view = selectBrowserView(context, paneId, lines);
    return view.pageTitle || browserTitle(view.url);
  },

  selectMenuItems: (context, paneId, lines): WidgetMenuItem[] => {
    const view = selectBrowserView(context, paneId, lines);
    const source = view.url;
    return [
      {
        id: 'browser-zoom-in',
        label: 'Zoom In',
        event: { type: 'BROWSER_ZOOM', paneId, source, delta: ZOOM_STEP },
      },
      {
        id: 'browser-zoom-out',
        label: 'Zoom Out',
        event: { type: 'BROWSER_ZOOM', paneId, source, delta: -ZOOM_STEP },
      },
      {
        id: 'browser-copy-url',
        label: 'Copy Current URL',
        event: { type: 'BROWSER_COPY_URL', url: view.url },
      },
      {
        id: 'browser-refresh',
        label: 'Refresh',
        keyHint: 'ctrl+r',
        event: { type: 'BROWSER_RELOAD', paneId, source },
      },
      {
        id: 'browser-close',
        label: 'Close Browser',
        keyHint: 'ctrl+c',
        // The same SIGINT the generic widget ctrl+c sends: it ends the
        // `tmuxy widget browser` process, whose EXIT trap clears the marker
        // and hands the pane back to a shell.
        event: { type: 'SEND_KEYS', paneId, keys: 'C-c' },
      },
    ];
  },

  onKeyDown: (event, { paneId, lines, send }) => {
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'r') {
      send({ type: 'BROWSER_RELOAD', paneId, source: parseSource(lines) });
      return true;
    }
    return false;
  },
};
