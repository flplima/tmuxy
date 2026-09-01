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

import { useAppSend, useAppSelector } from '../machines/AppContext';
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
  const labels = LABELS[side];

  return (
    <button
      className={`sidebar-toggle sidebar-toggle-${side}${open ? ' sidebar-toggle-active' : ''}`}
      aria-label={labels.aria}
      aria-pressed={open}
      title={labels.title}
      onClick={() =>
        send({ type: side === 'left' ? 'TOGGLE_LEFT_SIDEBAR' : 'TOGGLE_RIGHT_SIDEBAR' })
      }
    >
      <SidebarGlyph side={side} />
    </button>
  );
}
