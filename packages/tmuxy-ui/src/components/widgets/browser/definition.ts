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

  selectTitle: (context, paneId, lines) =>
    browserTitle(selectBrowserView(context, paneId, lines).url),

  selectMenuItems: (context, paneId, lines): WidgetMenuItem[] => {
    const view = selectBrowserView(context, paneId, lines);
    const source = view.source;
    return [
      {
        id: 'browser-back',
        label: 'Back',
        disabled: !view.canGoBack,
        event: { type: 'BROWSER_BACK', paneId, source },
      },
      {
        id: 'browser-forward',
        label: 'Forward',
        disabled: !view.canGoForward,
        event: { type: 'BROWSER_FORWARD', paneId, source },
      },
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
