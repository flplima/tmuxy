/**
 * browser state — parallel state for the browser widget's per-pane history,
 * zoom and refresh (components/widgets/browser).
 *
 * Owns context field: browserStates.
 *
 * Spread into states.idle.on: a browser pane only exists once the session is
 * connected and rendering, the same as copy mode.
 *
 * Action implementations live in ../actions/browser.ts.
 */

export const browserState = {
  on: {
    BROWSER_NAVIGATE: { actions: 'browser_navigate' },
    BROWSER_BACK: { actions: 'browser_back' },
    BROWSER_FORWARD: { actions: 'browser_forward' },
    BROWSER_ZOOM: { actions: 'browser_zoom' },
    BROWSER_RELOAD: { actions: 'browser_reload' },
    BROWSER_COPY_URL: { actions: 'browser_copyUrl' },
  },
} as const;
