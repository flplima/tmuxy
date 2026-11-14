/**
 * palette state — the command palette (open, and in which mode) and a place
 * in another session it was asked to go to.
 *
 * Spread into the machine root: opening and closing are client-side, and
 * GO_TO ends in the events a click raises (SELECT_TAB, SELECT_PANE,
 * SWITCH_SESSION), which are valid in any connected state.
 */

export const paletteGlobalEvents = {
  TOGGLE_PALETTE: { actions: 'palette_toggle' },
  CLOSE_PALETTE: { actions: 'palette_close' },
  GO_TO: { actions: 'palette_goTo' },
} as const;
