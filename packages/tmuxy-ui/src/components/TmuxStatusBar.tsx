/**
 * TmuxStatusBar - Bottom status line with hints, tmux status, host, and session
 *
 * Layout: [left: hints] [center: tmux status line] [right: host + session]
 *
 * Three center-area modes (cascading priority):
 * 1. Command mode: shows command prompt input (like tmux prefix+:)
 * 2. Status message: shows temporary message (from display-message)
 * 3. Default: renders tmux status line with ANSI colors
 */

import { useRef, useEffect, useCallback } from 'react';
import {
  useAppSelector,
  useAppSend,
  useAppConfig,
  selectCommandMode,
  selectStatusMessage,
  selectGridDimensions,
  selectSessionName,
  selectKeyBindings,
  selectPrefixActive,
  selectActivePaneCopyMode,
} from '../machines/AppContext';
import { formatPrefixKey } from './menus/keybindingLabel';
import { isTauri } from '../tmux/adapters';
import type { KeyBindings } from '../machines/types';

const PREFIX_HINTS = [
  { key: '-', label: 'split h' },
  { key: '|', label: 'split v' },
  { key: 'x', label: 'close pane' },
  { key: 'c', label: 'new tab' },
];

function Separator() {
  return <span style={{ opacity: 0.3, padding: '0 0.35em' }}>⋅</span>;
}

function Key({ children, active }: { children: string; active?: boolean }) {
  return (
    <>
      <span className="statusline-bracket">[</span>
      <kbd className={active ? 'statusline-prefix-active' : undefined}>{children}</kbd>
      <span className="statusline-bracket">]</span>
    </>
  );
}

function StatusLineHints({
  keybindings,
  prefixActive,
}: {
  keybindings: KeyBindings | null;
  prefixActive: boolean;
}) {
  if (!keybindings) return null;

  const prefix = formatPrefixKey(keybindings.prefix_key);

  if (prefixActive) {
    return (
      <span className="statusline-hints">
        <Key active>{prefix}</Key>
        <Separator />
        {PREFIX_HINTS.map(({ key, label }, i) => (
          <span key={key}>
            {i > 0 && <Separator />}
            <Key>{key}</Key> <span className="statusline-hint-desc">{label}</span>
          </span>
        ))}
      </span>
    );
  }

  const hasNav = ['C-h', 'C-j', 'C-k', 'C-l'].some((key) =>
    keybindings.root_bindings.some(
      (b) => b.key === key && (b.command.includes('tmuxy-nav') || b.command.includes('tmuxy/nav')),
    ),
  );

  const hasTabs = keybindings.root_bindings.some(
    (b) => /^C-[0-9]$/.test(b.key) && b.command.includes('select-window'),
  );

  return (
    <span className="statusline-hints">
      <Key>{prefix}</Key> <span className="statusline-hint-desc">prefix</span>
      {hasNav && (
        <>
          <Separator />
          <Key>ctrl+hjkl</Key> <span className="statusline-hint-desc">pane nav</span>
        </>
      )}
      {hasTabs && (
        <>
          <Separator />
          <Key>ctrl+&lt;0-9&gt;</Key> <span className="statusline-hint-desc">tab nav</span>
        </>
      )}
    </span>
  );
}

const COPY_MODE_HINTS = [
  { key: 'hjkl', label: 'nav' },
  { key: 'v', label: 'select' },
  { key: 'y', label: 'copy' },
  { key: 'esc', label: 'quit' },
];

function CopyModeHints() {
  return (
    <span className="statusline-hints">
      <span className="statusline-copy-mode-label">[COPY]</span>
      {COPY_MODE_HINTS.map(({ key, label }) => (
        <span key={key}>
          <Separator />
          <Key>{key}</Key> <span className="statusline-hint-desc">{label}</span>
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
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const sessionName = useAppSelector(selectSessionName);
  const keybindings = useAppSelector(selectKeyBindings);
  const prefixActive = useAppSelector(selectPrefixActive);
  const inCopyMode = useAppSelector(selectActivePaneCopyMode);
  const send = useAppSend();
  const { isDemo } = useAppConfig();

  const gridPixelWidth = totalWidth * charWidth;

  // Command mode: full-width input replaces everything
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

  const hostname = isDemo
    ? 'demo@localhost'
    : isTauri()
      ? 'localhost'
      : window.location.hostname || 'localhost';

  const handleHostClick = isDemo
    ? undefined
    : () => {
        if (isTauri()) {
          send({ type: 'OPEN_CONNECT_FLOAT' });
        } else {
          send({ type: 'SHOW_STATUS_MESSAGE', text: 'SSH only available in desktop app' });
        }
      };

  const handleSessionClick = isDemo ? undefined : () => send({ type: 'OPEN_SESSION_FLOAT' });

  // Center area: only show status messages (temporary display-message output).
  // The tmux status line content is not displayed — we use hardcoded hints (left)
  // and hostname/session (right) instead.
  const centerContent = statusMessage ? (
    <pre className="tmux-status-bar-content tmux-status-message">{statusMessage.text}</pre>
  ) : null;

  return (
    <div className="tmux-status-bar" data-testid="tmux-status-bar">
      <div
        className="tmux-statusline-inner"
        style={gridPixelWidth > 0 ? { width: gridPixelWidth, margin: '0 auto' } : undefined}
      >
        <div className="tmux-statusline-left">
          {inCopyMode ? (
            <CopyModeHints />
          ) : (
            <StatusLineHints keybindings={keybindings} prefixActive={prefixActive} />
          )}
        </div>
        <div className="tmux-statusline-center">{centerContent}</div>
        <div className="tmux-statusline-right">
          <span
            className={`statusline-host${handleHostClick ? ' statusline-clickable' : ''}`}
            onClick={handleHostClick}
          >
            {hostname}
          </span>
          <span
            className={`statusline-session${handleSessionClick ? ' statusline-clickable' : ''}`}
            onClick={handleSessionClick}
          >
            [{sessionName}]
          </span>
        </div>
      </div>
    </div>
  );
}
