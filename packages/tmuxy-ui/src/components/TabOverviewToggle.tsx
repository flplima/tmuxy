/**
 * TabOverviewToggle - header icon-button that opens/closes the Tab Overview,
 * the "all tabs" grid (ctrl+0, prefix w).
 *
 * It sits at the start of the right cluster, just left of the dock's toggle:
 * the header's right end is where the app-wide views live. Pressed while the
 * overview is open; dispatches the same event the keybinding sends.
 */

import { useAppSend, useAppSelector } from '../machines/AppContext';

export function TabOverviewToggle() {
  const send = useAppSend();
  const open = useAppSelector((ctx) => ctx.tabOverviewOpen);
  return (
    <button
      className={`sidebar-toggle tab-overview-toggle${open ? ' sidebar-toggle-active' : ''}`}
      aria-label="Toggle all tabs"
      aria-pressed={open}
      title="All tabs (ctrl+0)"
      data-testid="tab-overview-toggle"
      onClick={() => send({ type: 'TOGGLE_TAB_OVERVIEW' })}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="5" height="5" rx="1" strokeWidth="1.3" />
        <rect x="9" y="2" width="5" height="5" rx="1" strokeWidth="1.3" />
        <rect x="2" y="9" width="5" height="5" rx="1" strokeWidth="1.3" />
        <rect x="9" y="9" width="5" height="5" rx="1" strokeWidth="1.3" />
      </svg>
    </button>
  );
}
