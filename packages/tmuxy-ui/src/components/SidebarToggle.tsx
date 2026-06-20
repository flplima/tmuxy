/**
 * SidebarToggle - header icon-button that opens/closes the left sidebar drawer.
 *
 * Sits between the app menu (or macOS traffic-light spacer) and the window tabs.
 * Reflects `sidebarOpen` as a pressed state; clicking dispatches TOGGLE_SIDEBAR,
 * the same event `prefix t` sends from the keyboard actor.
 */

import { useAppSend, useAppSelector } from '../machines/AppContext';

export function SidebarToggle() {
  const send = useAppSend();
  const sidebarOpen = useAppSelector((ctx) => ctx.sidebarOpen);

  return (
    <button
      className={`sidebar-toggle${sidebarOpen ? ' sidebar-toggle-active' : ''}`}
      aria-label="Toggle sidebar"
      aria-pressed={sidebarOpen}
      title="Toggle sidebar (prefix t)"
      onClick={() => send({ type: 'TOGGLE_SIDEBAR' })}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
        <rect x="2" y="2.75" width="12" height="10.5" rx="1.5" strokeWidth="1.3" />
        <rect x="2" y="2.75" width="4.5" height="10.5" rx="1.5" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
