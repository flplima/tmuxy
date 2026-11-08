/**
 * PhoneLeftSide — the column left of the terminal on a phone held sideways:
 * the menu's button at the top, as the desktop has it, and the tabs/panes
 * tree under it. The button puts the app menu in the tree's place, as the
 * phone's page list (PhoneMenu) — the desktop's dropdown hangs its submenus
 * to the side and runs taller than a sideways phone — and again puts the tree
 * back. Which is shown is the phone's bottom view (the `phone` slice): the
 * menu when it is the menu, the tree otherwise, so the menu a phone was
 * showing upright is the one it shows turned.
 */

import { memo } from 'react';
import { SidebarTree } from '../SidebarTree';
import { PhoneMenu } from './PhoneMenu';
import { MenuGlyph } from '../menus/AppMenu';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import { selectPhoneBottomView } from '../../machines/selectors/layout';

export const PhoneLeftSide = memo(function PhoneLeftSide() {
  const send = useAppSend();
  const menu = useAppSelector(selectPhoneBottomView) === 'menu';
  return (
    <>
      <div className="phone-side-strip">
        <button
          type="button"
          className={`app-menu-button phone-menu-toggle${menu ? ' is-open' : ''}`}
          aria-label="Menu"
          aria-expanded={menu}
          onClick={() => send({ type: 'SET_PHONE_BOTTOM_VIEW', view: menu ? 'tree' : 'menu' })}
        >
          <MenuGlyph />
        </button>
      </div>
      {menu ? (
        <PhoneMenu />
      ) : (
        <div className="phone-tree">
          <SidebarTree focused={false} />
        </div>
      )}
    </>
  );
});
