/**
 * SidebarBackdrop — the scrim behind an OVERLAYING sidebar column.
 *
 * Only rendered in the narrow layout, where a column floats over the panes and
 * the tab strip instead of docking beside them (see `selectSidebarLayout`).
 * There the panes underneath are still drawn but no longer reachable, so the
 * scrim both says so and gives the obvious "tap outside to dismiss" target.
 *
 * A docked column needs none of this: it takes its own width out of the grid,
 * and everything beside it stays live.
 */

import { memo, useCallback } from 'react';
import { useAppSend, useAppSelector, selectSidebarLayout } from '../machines/AppContext';

export const SidebarBackdrop = memo(function SidebarBackdrop() {
  const send = useAppSend();
  const { leftOpen, rightOpen, leftClosing, rightClosing, overlay } =
    useAppSelector(selectSidebarLayout);

  const handleClick = useCallback(() => {
    send({ type: leftOpen ? 'TOGGLE_LEFT_SIDEBAR' : 'TOGGLE_RIGHT_SIDEBAR' });
  }, [send, leftOpen]);

  const shown = leftOpen || rightOpen;
  if (!overlay || (!shown && !leftClosing && !rightClosing)) return null;

  return (
    <div
      className={`sidebar-backdrop${shown ? '' : ' is-closing'}`}
      data-testid="sidebar-backdrop"
      aria-hidden="true"
      onClick={handleClick}
    />
  );
});
