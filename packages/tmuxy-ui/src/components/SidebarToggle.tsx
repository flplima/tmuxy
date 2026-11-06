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
 * terminal). Resting the mouse on a closed column's toggle shows the column
 * over the panes until the pointer leaves it (useSidebarPeek); the click
 * docks it.
 */

import { useAppSend, useAppSelector } from '../machines/appHooks';
import { SidebarGlyph } from './SidebarColumn';
import { Tooltip } from './Tooltip';
import { useSidebarPeekToggle } from './useSidebarPeek';
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
  const shown = useAppSelector((ctx) => ctx.sidebars[side].open);
  const peeking = useAppSelector((ctx) => ctx.sidebarPeek === side);
  const labels = LABELS[side];
  const peek = useSidebarPeekToggle(side, !shown);

  return (
    // The peeking column already answers what the button does, and the
    // tooltip would sit over its first rows.
    <Tooltip label={peeking ? '' : labels.title}>
      <button
        className={`sidebar-toggle sidebar-toggle-${side}${shown ? ' sidebar-toggle-active' : ''}`}
        aria-label={labels.aria}
        aria-pressed={shown}
        onPointerEnter={peek.onPointerEnter}
        onPointerLeave={peek.onPointerLeave}
        onClick={() => send({ type: 'TOGGLE_SIDEBAR', side })}
      >
        <SidebarGlyph side={side} />
      </button>
    </Tooltip>
  );
}
