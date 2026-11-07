/**
 * tmux's own status line is not rendered: the hints (left) and host/session
 * (right) stand in, the centre shows only the client's own temporary status
 * ("Copied …"), and tmux's `display-message` output goes to the snackbar.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import {
  useAppSelector,
  useAppSelectorShallow,
  useAppSend,
  useAppConfig,
} from '../machines/appHooks';
import {
  selectCommandMode,
  selectStatusMessage,
  selectSessionName,
  selectKeyBindings,
  selectPrefixActive,
  selectKeyTable,
  selectActivePaneCopyMode,
} from '../machines/selectors/ui';
import { selectGridDimensions } from '../machines/selectors/layout';
import { gridPixelSize } from '../domain/paneGeometry';
import { HINT_SEPARATOR, modeHints, normalHints, type Hint } from './statusLineHints';
import { serverHostLabel } from '../domain/servers';
import { SessionMenu } from './SessionMenu';
import './TmuxStatusBar.css';

function Separator() {
  return <span className="statusline-separator">{HINT_SEPARATOR}</span>;
}

/** See statusLineHints.ts for what each mode says and the 80-column rule. */
function HintLine({ hints, mode }: { hints: readonly Hint[]; mode: string | null }) {
  return (
    <span
      className="statusline-hints"
      data-testid="statusline-hints"
      data-key-mode={mode ?? 'normal'}
    >
      {mode && <span className="statusline-mode">{mode.toUpperCase()}</span>}
      {hints.map((hint, i) => (
        <span key={hint.key}>
          {(mode || i > 0) && <Separator />}
          <span className="statusline-bracket">[</span>
          <kbd>{hint.key}</kbd>
          <span className="statusline-bracket">]</span>{' '}
          <span className="statusline-hint-desc">{hint.label}</span>
        </span>
      ))}
    </span>
  );
}

function CommandModeInput({
  prompt,
  input,
  gridWidth,
  send,
}: {
  prompt: string;
  input: string;
  gridWidth: number;
  send: ReturnType<typeof useAppSend>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        send({ type: 'COMMAND_MODE_SUBMIT', value: inputRef.current?.value ?? '' });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        send({ type: 'COMMAND_MODE_CANCEL' });
      }
    },
    [send],
  );

  return (
    <div className="tmux-status-bar tmux-command-mode" data-testid="tmux-command-mode">
      <div className="tmux-command-input-wrapper" style={{ width: gridWidth }}>
        <span className="tmux-command-prompt">{prompt}</span>
        <input
          ref={inputRef}
          className="tmux-command-input"
          type="text"
          defaultValue={input}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}

export function TmuxStatusBar() {
  const commandMode = useAppSelector(selectCommandMode);
  const statusMessage = useAppSelector(selectStatusMessage);
  const { totalWidth, totalHeight, charWidth, charHeight } = useAppSelector(selectGridDimensions);
  const sessionName = useAppSelector(selectSessionName);
  const servers = useAppSelectorShallow((ctx) => ctx.servers);
  const currentServerId = useAppSelector((ctx) => ctx.currentServerId);
  const serverHostname = useAppSelector((ctx) => ctx.serverHostname);
  const keybindings = useAppSelector(selectKeyBindings);
  const prefixActive = useAppSelector(selectPrefixActive);
  const keyTable = useAppSelector(selectKeyTable);
  const inCopyMode = useAppSelector(selectActivePaneCopyMode);
  const send = useAppSend();
  const { isDemo } = useAppConfig();
  const switcherRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const gridPixelWidth = gridPixelSize(totalWidth, totalHeight, charWidth, charHeight).width;

  if (commandMode) {
    return (
      <CommandModeInput
        prompt={commandMode.prompt}
        input={commandMode.input}
        gridWidth={gridPixelWidth}
        send={send}
      />
    );
  }

  const hostname = serverHostLabel(servers, currentServerId, isDemo, serverHostname);

  // Host and session open the same switcher, hung from the pair; it opens
  // upward, since the status line is the window's last row.
  const handleSwitcherClick = isDemo
    ? undefined
    : () => {
        if (!menuOpen) send({ type: 'SESSION_MENU_OPENED' });
        setMenuOpen(!menuOpen);
      };

  const centerContent = statusMessage ? (
    <pre className="tmux-status-bar-content tmux-status-message">{statusMessage.text}</pre>
  ) : null;

  const mode = keyTable ?? (prefixActive ? 'prefix' : inCopyMode ? 'copy' : null);
  const hints = mode ? modeHints(keybindings, mode) : keybindings ? normalHints(keybindings) : null;

  return (
    <div className="tmux-status-bar" data-testid="tmux-status-bar">
      {/* Full width, whatever the pane grid measures: with a sidebar open the
          grid is narrower than the window, but the hints stay at the window's
          left edge and the host/session at its right. */}
      <div className="tmux-statusline-inner">
        <div className="tmux-statusline-left">
          {hints && <HintLine hints={hints} mode={mode} />}
        </div>
        <div className="tmux-statusline-center">{centerContent}</div>
        <div className="tmux-statusline-right" ref={switcherRef} hidden={mode !== null}>
          <span
            className={`statusline-host${handleSwitcherClick ? ' statusline-clickable' : ''}`}
            onClick={handleSwitcherClick}
          >
            {hostname}
          </span>
          <span
            className={`statusline-session${handleSwitcherClick ? ' statusline-clickable' : ''}`}
            onClick={handleSwitcherClick}
          >
            [{sessionName}]
          </span>
          {menuOpen && <SessionMenu anchorRef={switcherRef} onClose={() => setMenuOpen(false)} />}
        </div>
      </div>
    </div>
  );
}
