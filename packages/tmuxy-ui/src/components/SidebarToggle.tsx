/**
 * SidebarToggle - header icon-button that opens/closes one of the two sidebars.
 *
 * Each toggle lives in its own sidebar's cluster but keeps a fixed place in
 * the header: the left one right after the menu, the right one at the far
 * right end. Opening a column widens the cluster around the title, not the
 * toggle, so the click that opened the column closes it from the same spot.
 *
 * Each reflects its sidebar's open flag as a pressed state, and dispatches the
 * same event its `prefix` keybinding sends (`t` for the tree, `T` for the
 * terminal).
 */

import { useAppSend, useAppSelector } from '../machines/appHooks';
import { SidebarGlyph } from './SidebarColumn';
import { Tooltip } from './Tooltip';
import './SidebarToggle.css';

interface SidebarToggleProps {
  side: 'left' | 'right';
}

const LABELS = {
  left: { aria: 'Toggle tree sidebar', title: 'Toggle tree sidebar (prefix s)' },
  right: { aria: 'Toggle terminal sidebar', title: 'Toggle terminal sidebar (prefix S)' },
} as const;

export function SidebarToggle({ side }: SidebarToggleProps) {
  const send = useAppSend();
  const shown = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarOpen : ctx.rightSidebarOpen,
  );
  const labels = LABELS[side];

  return (
    <Tooltip label={labels.title}>
      <button
        className={`sidebar-toggle sidebar-toggle-${side}${shown ? ' sidebar-toggle-active' : ''}`}
        aria-label={labels.aria}
        aria-pressed={shown}
        onClick={() =>
          send({ type: side === 'left' ? 'TOGGLE_LEFT_SIDEBAR' : 'TOGGLE_RIGHT_SIDEBAR' })
        }
      >
        <SidebarGlyph side={side} />
      </button>
    </Tooltip>
  );
}
