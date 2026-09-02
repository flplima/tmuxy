/**
 * SidebarToggle - header icon-button that opens/closes one of the two sidebars.
 *
 * Each toggle rides its own sidebar's cluster: the left one sits at the end of
 * the left cluster (so an open column puts it just inside that column's
 * divider), the right one at the start of the right cluster. The button
 * therefore always reads as belonging to the panel it controls.
 *
 * Each reflects its sidebar's open flag as a pressed state, and dispatches the
 * same event its `prefix` keybinding sends (`t` for the tree, `T` for the
 * terminal).
 */

import { useAppSend, useAppSelector, selectSidebarLayout } from '../machines/AppContext';
import { SidebarGlyph } from './SidebarColumn';

interface SidebarToggleProps {
  side: 'left' | 'right';
}

const LABELS = {
  left: { aria: 'Toggle tree sidebar', title: 'Toggle tree sidebar (prefix t)' },
  right: { aria: 'Toggle terminal sidebar', title: 'Toggle terminal sidebar (prefix T)' },
} as const;

export function SidebarToggle({ side }: SidebarToggleProps) {
  const send = useAppSend();
  const open = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarOpen : ctx.rightSidebarOpen,
  );
  // What is actually on screen. In a window too narrow for two overlays the
  // layout shows the tree and suppresses the dock, so the dock's toggle must
  // not claim it is open — pressing it would then toggle something invisible.
  const layout = useAppSelector(selectSidebarLayout);
  const shown = side === 'left' ? layout.leftOpen : layout.rightOpen;
  const suppressed = open && !shown;
  const labels = LABELS[side];

  return (
    <button
      className={`sidebar-toggle sidebar-toggle-${side}${shown ? ' sidebar-toggle-active' : ''}`}
      aria-label={labels.aria}
      aria-pressed={shown}
      disabled={suppressed}
      title={
        suppressed ? `${labels.title} — hidden while the tree overlays the panes` : labels.title
      }
      onClick={() =>
        send({ type: side === 'left' ? 'TOGGLE_LEFT_SIDEBAR' : 'TOGGLE_RIGHT_SIDEBAR' })
      }
    >
      <SidebarGlyph side={side} />
    </button>
  );
}
