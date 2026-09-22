/**
 * Action implementations for the browser parallel state.
 *
 * Owns context field: browserStates (per-pane BrowserPaneState records).
 *
 * A record is created the first time a pane is zoomed or refreshed; until then
 * the widget renders the source its pane content declares at zoom 1, so an
 * untouched browser pane costs nothing here. See
 * components/widgets/browser/view.ts for the other half of that split.
 */

import { assign, enqueueActions } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents, BrowserPaneState } from '../../types';
import { clampZoom, normalizeAddress } from '../../../components/widgets/browser/view';
import { isOpenableUrl, openExternalUrl } from '../../../utils/openUrl';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/**
 * Apply a change to one pane's record.
 *
 * A record is created when the pane has none — and equally when the one it has
 * belongs to a different source, which is a previous browser's record left in
 * a pane that has since been pointed somewhere else. Starting fresh there is
 * what stops a reopened browser from inheriting the last one's zoom.
 */
function update(
  context: Ctx,
  paneId: string,
  source: string,
  change: (state: BrowserPaneState) => BrowserPaneState | null,
): Partial<Ctx> {
  const current = context.browserStates[paneId];
  const base: BrowserPaneState =
    current?.source === source
      ? current
      : // A fresh record starts where the pane was pointed: the declared
        // source is history's first entry, so `back` from the first page the
        // user navigates to returns to it.
        { source, zoom: 1, reloadNonce: 0, history: [source], historyIndex: 0 };
  const next = change(base);
  if (!next) return {};
  return { browserStates: { ...context.browserStates, [paneId]: next } };
}

export const browserActions = {
  browser_zoom: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_ZOOM') return {};
    return update(context, event.paneId, event.source, (state) => {
      const zoom = clampZoom(state.zoom + event.delta);
      return zoom === state.zoom ? null : { ...state, zoom };
    });
  }),

  browser_reload: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_RELOAD') return {};
    return update(context, event.paneId, event.source, (state) => ({
      ...state,
      reloadNonce: state.reloadNonce + 1,
    }));
  }),

  browser_navigate: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_NAVIGATE') return {};
    const url = normalizeAddress(event.url);
    if (!url) return {};
    return update(context, event.paneId, event.source, (state) => {
      if (state.history[state.historyIndex] === url) return null;
      // Navigating from a page you went BACK to drops what was ahead of it,
      // the way every browser's history does: the forward branch is the one
      // you just chose not to take.
      const history = [...state.history.slice(0, state.historyIndex + 1), url];
      return { ...state, history, historyIndex: history.length - 1 };
    });
  }),

  browser_pageTitle: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_PAGE_TITLE') return {};
    return update(context, event.paneId, event.source, (state) => {
      // A title that arrives for a page the pane has already left is dropped:
      // the fetch is async, and a fast back/forward can outrun it.
      if (state.history[state.historyIndex] !== event.url) return null;
      if (state.pageTitle?.url === event.url && state.pageTitle.title === event.title) return null;
      return { ...state, pageTitle: { url: event.url, title: event.title } };
    });
  }),

  browser_history: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_HISTORY') return {};
    return update(context, event.paneId, event.source, (state) => {
      const next = state.historyIndex + event.delta;
      if (next < 0 || next >= state.history.length) return null;
      return { ...state, historyIndex: next };
    });
  }),

  browser_openExternal: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, enqueue }) => {
      if (event.type !== 'BROWSER_OPEN_EXTERNAL') return;
      // Only http(s)/mailto ever leave the app (`openExternalUrl` refuses the
      // rest), so a local file the pane is showing is turned down here with a
      // reason rather than handed over — or worse, silently doing nothing.
      if (!isOpenableUrl(event.url)) {
        enqueue.raise({
          type: 'NOTIFY' as const,
          text: 'Only http(s) pages can be opened in the default browser',
        });
        return;
      }
      openExternalUrl(event.url);
      enqueue.raise({
        type: 'SHOW_STATUS_MESSAGE' as const,
        text: `Opened ${event.url} in the default browser`,
      });
    },
  ),

  browser_copyUrl: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, self }) => {
      if (event.type !== 'BROWSER_COPY_URL') return;
      const url = event.url;
      // Both outcomes are reported — success on the status line, failure as
      // a snackbar: a clipboard write can be refused (no permission, no
      // secure context) and a silent no-op would leave the user pasting
      // whatever was there before. The result arrives after this action
      // returns, so it goes back in through `self` rather than the enqueue,
      // which is only live for this synchronous pass.
      navigator.clipboard.writeText(url).then(
        () => self.send({ type: 'SHOW_STATUS_MESSAGE', text: `Copied ${url}` }),
        (e: unknown) => self.send({ type: 'NOTIFY', text: `Copy failed: ${String(e)}` }),
      );
    },
  ),
};
