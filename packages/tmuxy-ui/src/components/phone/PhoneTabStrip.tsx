/**
 * The phone layout's tab strip: no sidebar toggles, overview button or "+" (the
 * app menu opens a tab).
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
