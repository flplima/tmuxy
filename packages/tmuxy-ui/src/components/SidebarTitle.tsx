/**
 * A docked column has no header of its own, so its title lives in the app
 * header, in a cluster sized to the column's width. Its colour is the
 * column's only focus cue: the divider stays flat in every state.
 */

import { memo, useCallback, useRef, useState } from 'react';
import { useAppSend, useAppSelector } from '../machines/appHooks';
import { selectRightSidebarPane } from '../machines/selectors/panesAndSidebars';
import { selectSidebarHoldsKeyboard } from '../machines/selectors/keyboard';
import { sidebarShellTitle } from './paneTabDisplay';
import { Tooltip } from './Tooltip';
import { SessionMenu } from './SessionMenu';
import './SidebarTitle.css';

export const SidebarTitle = memo(function SidebarTitle({ side }: { side: 'left' | 'right' }) {
  const send = useAppSend();
  const sessionName = useAppSelector((ctx) => ctx.sessionName);
  const rightPane = useAppSelector(selectRightSidebarPane);
  const focused = useAppSelector((ctx) => selectSidebarHoldsKeyboard(ctx, side));

  const switcherRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // The title is the column's handle up here: clicking it focuses the column,
  // the same as clicking the column itself. That matters because a click inside
  // the column lands on whatever the pane is showing — a tree row activates it —
  // so the title is the one spot that focuses and does nothing else.
  const focusColumn = useCallback(() => send({ type: 'FOCUS_SIDEBAR', side }), [send, side]);

  return (
    <span
      className={`sidebar-title sidebar-title-${side}${focused ? ' is-focused' : ''}`}
      data-testid={`sidebar-title-${side}`}
      onClick={focusColumn}
    >
      <span className="sidebar-title-text">
        {side === 'left' ? (
          <strong className="sidebar-title-session">{sessionName}</strong>
        ) : (
          sidebarShellTitle(rightPane)
        )}
      </span>
      {side === 'left' && (
        <Tooltip label="Switch session">
          <button
            type="button"
            className="sidebar-title-switcher"
            aria-label="Switch session"
            aria-haspopup="dialog"
            ref={switcherRef}
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              if (!menuOpen) send({ type: 'SESSION_MENU_OPENED' });
              setMenuOpen(!menuOpen);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor">
              <path d="M2 3.75 L5 6.75 L8 3.75" strokeWidth="1.4" />
            </svg>
          </button>
        </Tooltip>
      )}
      {menuOpen && <SessionMenu anchorRef={switcherRef} onClose={() => setMenuOpen(false)} />}
    </span>
  );
});
