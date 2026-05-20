/**
 * layout state — parallel state for panes, windows, focus, and optimistic ops.
 *
 * Owns context fields: panes, windows, activeWindowId, activePaneId,
 * paneActivationOrder, lastActivePaneByWindow, optimisticOperation,
 * paneKeyOverrides, pendingSelectTabAt, pendingUpdate.
 *
 * Includes optimistic split/navigate/swap/new-window/select-window logic
 * (uses ../optimistic/ helpers internally).
 *
 * Placeholder for Task #10 migration — the largest. Not yet wired into appMachine.
 */

export const layoutState = {
  on: {},
};

export const layoutSelectors = {};
