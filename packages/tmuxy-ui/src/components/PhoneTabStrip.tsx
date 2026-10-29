/**
 * PhoneTabStrip - the phone layout's tab strip, over the terminal.
 *
 * The desktop header without most of its chrome: the app menu at the left
 * end, the tabs, then the "+" at the right end. No sidebar toggles (a phone
 * has no sidebars) and no overview button. The menu and the "+" are drawn
 * like the key row's keys, a thumb's width each; the tab list takes the width
 * between them and scrolls sideways when the tabs outgrow the screen, as the
 * desktop one does, so neither end ever leaves it.
 */

import { AppMenu } from './menus/AppMenu';
import { WindowTabs } from './WindowTabs';
import { NewTabButton } from './NewTabButton';

export function PhoneTabStrip() {
  return (
    <div className="phone-tab-strip">
      <AppMenu />
      <WindowTabs />
      <NewTabButton />
    </div>
  );
}
