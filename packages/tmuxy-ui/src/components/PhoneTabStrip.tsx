/**
 * PhoneTabStrip - the phone layout's tab strip, over the terminal.
 *
 * The desktop header without its chrome: the tabs, then the "+" at the right
 * end. No app menu (it ends the key row), no sidebar toggles (a phone has no
 * sidebars) and no overview button. The strip scrolls sideways when the tabs
 * outgrow the screen, as the desktop one does, so the "+" never leaves it.
 */

import { WindowTabs } from './WindowTabs';
import { NewTabButton } from './NewTabButton';

export function PhoneTabStrip() {
  return (
    <div className="phone-tab-strip">
      <WindowTabs />
      <NewTabButton />
    </div>
  );
}
