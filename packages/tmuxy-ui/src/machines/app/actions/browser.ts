/**
 * Action implementations for the browser parallel state.
 *
 * Owns context field: browserStates (per-pane BrowserPaneState records).
 *
 * A record is created the first time a pane is navigated, zoomed or refreshed;
 * until then the widget renders the source its pane content declares at zoom
 * 1, so an untouched browser pane costs nothing here. See
 * components/widgets/browser/view.ts for the other half of that split.
 */

import { assign, enqueueActions } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents, BrowserPaneState } from '../../types';
import { clampZoom } from '../../../components/widgets/browser/view';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/**
 * Apply a change to one pane's record.
 *
 * A record is created when the pane has none — and equally when the one it has
 * belongs to a different source, which is a previous browser's history left in
 * a pane that has since been pointed somewhere else. Starting fresh there is
 * what stops a reopened browser from inheriting the last one's back stack and
 * zoom.
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
      : { source, pushed: [], index: 0, zoom: 1, reloadNonce: 0 };
  const next = change(base);
  if (!next) return {};
  return { browserStates: { ...context.browserStates, [paneId]: next } };
}

export const browserActions = {
  // A page the frame reached on its own (a link followed inside a document
  // tmuxy serves). Truncates anything ahead of the cursor, exactly as a
  // browser drops the forward stack when you navigate off a back step.
  browser_navigate: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_NAVIGATE') return {};
    return update(context, event.paneId, event.source, (state) => {
      const pushed = [...state.pushed.slice(0, state.index), event.url];
      return { ...state, pushed, index: pushed.length };
    });
  }),

  browser_back: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_BACK') return {};
    return update(context, event.paneId, event.source, (state) =>
      state.index > 0 ? { ...state, index: state.index - 1 } : null,
    );
  }),

  browser_forward: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'BROWSER_FORWARD') return {};
    return update(context, event.paneId, event.source, (state) =>
      state.index < state.pushed.length ? { ...state, index: state.index + 1 } : null,
    );
  }),

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

  browser_copyUrl: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ event, self }) => {
      if (event.type !== 'BROWSER_COPY_URL') return;
      const url = event.url;
      // The status line reports both outcomes: a clipboard write can be
      // refused (no permission, no secure context) and a silent no-op would
      // leave the user pasting whatever was there before. The result arrives
      // after this action returns, so it goes back in through `self` rather
      // than the enqueue, which is only live for this synchronous pass.
      navigator.clipboard.writeText(url).then(
        () => self.send({ type: 'SHOW_STATUS_MESSAGE', text: `Copied ${url}` }),
        (e: unknown) =>
          self.send({ type: 'SHOW_STATUS_MESSAGE', text: `Copy failed: ${String(e)}` }),
      );
    },
  ),
};
