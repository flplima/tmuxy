/**
 * The hamburger: the application menu where there is no native menu bar (the
 * web, the demo, Linux).
 */

import { useRef, useState } from 'react';
import { FloatingMenu } from '../floating/Menu';
import { useAppSelector } from '../../machines/appHooks';
import { appMenuSpec } from './specs/appMenu';
import { renderSpec } from './SpecMenu';
import { useMenuEnv } from './menuEnv';
import { useAppMenuSurface } from './useAppMenuSurface';
import './AppMenu.css';

export function AppMenu() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const env = useMenuEnv();
  const { dispatch, options, dialogs } = useAppMenuSurface(env);

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
          ignoreRef={buttonRef}
        >
          {renderSpec(spec, dispatch)}
        </FloatingMenu>
      )}
      {dialogs}
    </>
  );
}
