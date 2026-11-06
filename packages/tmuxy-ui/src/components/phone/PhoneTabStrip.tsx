/**
 * PhoneTabStrip - the phone layout's tab strip, over the terminal.
 *
 * The desktop header without most of its chrome: the app menu at the left
 * end, then the tabs. No sidebar toggles (a phone has no sidebars), no
 * overview button and no "+" (the app menu opens a tab). The menu is a
 * thumb's width; the tab list takes the rest of the width and scrolls
 * sideways when the tabs outgrow the screen, as the desktop one does, so the
 * menu never leaves it.
 */

import { AppMenu } from '../menus/AppMenu';
import { WindowTabs } from '../WindowTabs';

export function PhoneTabStrip() {
  return (
    <div className="phone-tab-strip">
      <AppMenu />
      <WindowTabs />
    </div>
  );
}
