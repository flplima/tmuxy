/**
 * AppMenu — the hamburger: the application menu where there is no native
 * menu bar (the web, the demo, Linux). The items are the `appMenuSpec`
 * (domain/menus), rendered by the floating menu; the surface's own verbs and
 * dialogs come from `useAppMenuSurface`, shared with the native menu bar.
 */

import { useRef, useState } from 'react';
import { FloatingMenu } from '../floating/Menu';
import { useAppSelector } from '../../machines/AppContext';
import { appMenuSpec } from '../../domain/menus/appMenu';
import { renderSpec } from './SpecMenu';
import { useMenuEnv } from './menuEnv';
import { useAppMenuSurface } from './useAppMenuSurface';
import './AppMenu.css';

export function AppMenu() {
  // The button owns the open flag and the menu hangs off the button: the
  // floating layer, the placement and the exit are the surface's
  // (components/floating), which is what makes this the same object as the
  // context menus and the tab preview.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const env = useMenuEnv();
  const { dispatch, options, dialogs } = useAppMenuSurface(env);

  // The spec is derived from the whole context, so it is built only while
  // the menu is up — the button alone has nothing to derive. A state change
  // while it is up re-renders the item list through the selector.
  const spec = useAppSelector((ctx) => (menuOpen ? appMenuSpec(ctx, env, options) : []));

  return (
    <>
      <button
        ref={buttonRef}
        className="app-menu-button"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="2" y="3" width="12" height="1.5" rx="0.5" />
          <rect x="2" y="7.25" width="12" height="1.5" rx="0.5" />
          <rect x="2" y="11.5" width="12" height="1.5" rx="0.5" />
        </svg>
      </button>
      {menuOpen && (
        <FloatingMenu
          id="app-menu"
          label="Application"
          anchor={{ kind: 'element', element: buttonRef.current }}
          onClose={() => setMenuOpen(false)}
          // The press that closes an open menu must not be the press that
          // reopens it: the button is the menu's own, not "outside" it.
          ignoreRef={buttonRef}
        >
          {renderSpec(spec, dispatch)}
        </FloatingMenu>
      )}
      {dialogs}
    </>
  );
}
