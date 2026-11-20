/**
 * The phone's tab strip, at the top of the screen over the terminal, upright
 * and held sideways: the desktop's tabs and the buttons at their right end
 * (StatusBar.tsx), the whole width. A phone has no sidebars, so neither
 * their toggles nor their titles; the app menu and the link's round trip are
 * the bottom view's (held sideways, the left column's).
 */

import { TabStripActions } from '../StatusBar';
import { WindowTabs } from '../WindowTabs';

export function PhoneTabStrip() {
  return (
    <div className="statusbar phone-tab-strip" data-testid="phone-tab-strip">
      <div className="statusbar-inner">
        <WindowTabs />
        <TabStripActions latency={false} />
      </div>
    </div>
  );
}
