import { useAppSend, useAppSelector } from '../machines/appHooks';
import { Tooltip } from './Tooltip';
import { selectKeyBindings } from '../machines/selectors/ui';
import { clientKeyHint, withKeyHint } from '../domain/keyLabels';

export function TabOverviewToggle() {
  const send = useAppSend();
  const open = useAppSelector((ctx) => ctx.tabOverviewOpen);
  const keybindings = useAppSelector(selectKeyBindings);
  const hint = clientKeyHint(keybindings, 'tab-overview');
  return (
    <Tooltip label={withKeyHint('All tabs', hint)}>
      <button
        className={`sidebar-toggle tab-overview-toggle${open ? ' sidebar-toggle-active' : ''}`}
        aria-label="Toggle all tabs"
        aria-pressed={open}
        data-testid="tab-overview-toggle"
        onClick={() => send({ type: 'TOGGLE_TAB_OVERVIEW' })}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
          <rect x="2" y="2" width="5" height="5" rx="1" strokeWidth="1.3" />
          <rect x="9" y="2" width="5" height="5" rx="1" strokeWidth="1.3" />
          <rect x="2" y="9" width="5" height="5" rx="1" strokeWidth="1.3" />
          <rect x="9" y="9" width="5" height="5" rx="1" strokeWidth="1.3" />
        </svg>
      </button>
    </Tooltip>
  );
}
