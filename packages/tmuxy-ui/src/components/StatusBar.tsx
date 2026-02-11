/**
 * StatusBar - Top bar with window tabs
 *
 * Minimalist design - just flat window tabs.
 */

import { WindowTabs } from './WindowTabs';

export function StatusBar() {
  return (
    <div className="statusbar">
      <WindowTabs />
    </div>
  );
}
