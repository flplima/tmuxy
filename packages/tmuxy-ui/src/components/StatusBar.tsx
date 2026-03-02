/**
 * StatusBar - Top bar with hints, window tabs, and session info
 *
 * Layout: [left: menu + hints] [center: tabs] [right: host + session]
 * Content is centered to match pane/status-bar width (totalWidth * charWidth).
 */

import type { RenderTabline } from '../App';
import {
  useAppSelector,
  useAppSend,
  selectGridDimensions,
  selectSessionName,
  selectKeyBindings,
} from '../machines/AppContext';
import { WindowTabs } from './WindowTabs';
import { AppMenu } from './menus/AppMenu';
import { formatPrefixKey } from './menus/keybindingLabel';
import { isTauri } from '../tmux/adapters';
import type { KeyBindings } from '../machines/types';
import './StatusBar.css';

function StatusBarHints({ keybindings }: { keybindings: KeyBindings | null }) {
  if (!keybindings) return null;

  const prefix = formatPrefixKey(keybindings.prefix_key);

  // Check for pane nav bindings (C-h/j/k/l in root bindings)
  const hasNav = ['C-h', 'C-j', 'C-k', 'C-l'].some((key) =>
    keybindings.root_bindings.some((b) => b.key === key && b.command.includes('tmuxy-nav')),
  );

  // Check for tab select bindings (C-0..C-9 in root bindings)
  const hasTabs = keybindings.root_bindings.some(
    (b) => /^C-[0-9]$/.test(b.key) && b.command.includes('select-window'),
  );

  return (
    <span className="statusbar-hints">
      <kbd>{prefix}</kbd> prefix
      {hasNav && (
        <>
          {'  '}
          <kbd>ctrl+hjkl</kbd> pane nav
        </>
      )}
      {hasTabs && (
        <>
          {'  '}
          <kbd>ctrl+[0-9]</kbd> tabs
        </>
      )}
    </span>
  );
}

export function StatusBar({ renderTabline }: { renderTabline?: RenderTabline }) {
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const sessionName = useAppSelector(selectSessionName);
  const keybindings = useAppSelector(selectKeyBindings);
  const send = useAppSend();

  const contentWidth = totalWidth > 0 ? totalWidth * charWidth : undefined;

  const hostname = isTauri() ? 'localhost' : window.location.hostname || 'localhost';

  const handleHostClick = () => {
    if (isTauri()) {
      send({ type: 'OPEN_CONNECT_FLOAT' });
    } else {
      send({ type: 'SHOW_STATUS_MESSAGE', text: 'SSH only available in desktop app' });
    }
  };

  const handleSessionClick = () => {
    send({ type: 'OPEN_SESSION_FLOAT' });
  };

  const defaultContent = (
    <>
      <div className="statusbar-left">
        <AppMenu />
        <StatusBarHints keybindings={keybindings} />
      </div>
      <div className="statusbar-center">
        <WindowTabs />
      </div>
      <div className="statusbar-right">
        <span className="statusbar-host" onClick={handleHostClick}>
          {hostname}
        </span>
        <span className="statusbar-session" onClick={handleSessionClick}>
          [{sessionName}]
        </span>
      </div>
    </>
  );

  return (
    <div className="statusbar">
      <div
        className="statusbar-inner"
        style={contentWidth ? { width: contentWidth, margin: '0 auto' } : undefined}
      >
        {renderTabline ? renderTabline({ children: defaultContent }) : defaultContent}
      </div>
    </div>
  );
}
