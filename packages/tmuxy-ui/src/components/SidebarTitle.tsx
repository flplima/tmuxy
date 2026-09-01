/**
 * SidebarTitle — a sidebar's label, shown in the app header above its column.
 *
 * Neither column carries a header of its own while docked, so the title lives up
 * here instead, inside a cluster sized to exactly that column's width. Its
 * brightness is the focus cue: full opacity when the column has the keyboard,
 * dimmed when it doesn't. That, plus where the cursor is, is the ONLY thing that
 * says which surface is focused — the divider between column and panes stays a
 * flat gray in every state.
 *
 * The left title is the session name and opens the session switcher, because
 * what the tree below it lists is that session's tabs. The right title is
 * whatever its pane is running, so a pinned `tail -f` says so.
 */

import { memo, useCallback } from 'react';
import { useAppSend, useAppSelector } from '../machines/AppContext';

export const SidebarTitle = memo(function SidebarTitle({
  side,
  title,
}: {
  side: 'left' | 'right';
  /** Overrides the derived label (the right column passes its pane's title). */
  title?: string;
}) {
  const send = useAppSend();
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const focused = useAppSelector((ctx) =>
    side === 'left' ? ctx.leftSidebarFocused : ctx.rightSidebarFocused,
  );

  const openSessions = useCallback(() => send({ type: 'OPEN_SESSION_FLOAT' }), [send]);

  // The title is the column's handle up here: clicking it focuses the column,
  // the same as clicking the column itself. That matters because a click inside
  // the column lands on whatever the pane is showing — a tree row activates it —
  // so the title is the one spot that focuses and does nothing else.
  const focusColumn = useCallback(
    () => send({ type: side === 'left' ? 'FOCUS_LEFT_SIDEBAR' : 'FOCUS_RIGHT_SIDEBAR' }),
    [send, side],
  );

  const label = title ?? (side === 'left' ? sessionName : 'shell');

  return (
    <span
      className={`sidebar-title sidebar-title-${side}${focused ? ' is-focused' : ''}`}
      data-testid={`sidebar-title-${side}`}
      onClick={focusColumn}
    >
      <span className="sidebar-title-text">{label}</span>
      {side === 'left' && (
        <button
          type="button"
          className="sidebar-title-switcher"
          title="Switch session"
          aria-label="Switch session"
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            openSessions();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
            <path d="M2 3.75 L5 6.75 L8 3.75" strokeWidth="1.4" />
          </svg>
        </button>
      )}
    </span>
  );
});
