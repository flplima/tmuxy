/**
 * Each toggle keeps a fixed place in the header (the left one after the menu,
 * the right one at the far end): opening a column widens the cluster around
 * the title, not the toggle, so the click that opened it closes it from the
 * same spot.
 */

import { useAppSend, useAppSelector } from '../machines/appHooks';
import { SidebarGlyph } from './SidebarColumn';
import { Tooltip } from './Tooltip';
import { useSidebarPeekToggle } from './useSidebarPeek';
import { selectKeyBindings } from '../machines/selectors/ui';
import { clientKeyHint, withKeyHint } from '../domain/keyLabels';
import './SidebarToggle.css';

interface SidebarToggleProps {
  side: 'left' | 'right';
}

const LABELS = {
  left: { aria: 'Toggle tree sidebar', key: 'left-sidebar' },
  right: { aria: 'Toggle terminal sidebar', key: 'right-sidebar' },
} as const;

export function SidebarToggle({ side }: SidebarToggleProps) {
  const send = useAppSend();
  const shown = useAppSelector((ctx) => ctx.sidebars[side].open);
  const peeking = useAppSelector((ctx) => ctx.sidebarPeek === side);
  const keybindings = useAppSelector(selectKeyBindings);
  const labels = LABELS[side];
  const title = withKeyHint(labels.aria, clientKeyHint(keybindings, labels.key));
  const peek = useSidebarPeekToggle(side, !shown);

  return (
    // The peeking column already answers what the button does, and the
    // tooltip would sit over its first rows.
    <Tooltip label={peeking ? '' : title}>
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
