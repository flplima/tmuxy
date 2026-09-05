/**
 * NewTabButton - the header's "+" that creates a tab.
 *
 * It lives with the Tab Overview button between the tab strip and the
 * right cluster, so the two tab-level actions sit together at the strip's
 * right end and stay over the pane area when the dock is docked (the
 * cluster to their right is the dock's).
 */

import { useAppSend } from '../machines/AppContext';

export function NewTabButton() {
  const send = useAppSend();
  return (
    <button
      className="tab-add"
      onClick={() => send({ type: 'CREATE_TAB' })}
      title="New tab"
      aria-label="Create new tab"
    >
      +
    </button>
  );
}
