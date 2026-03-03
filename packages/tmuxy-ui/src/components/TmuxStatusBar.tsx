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

import { useMemo, useRef, useEffect, useCallback } from 'react';
import Anser from 'anser';
import {
  useAppSelector,
  useAppSend,
  useAppConfig,
  selectStatusLine,
  selectCommandMode,
  selectStatusMessage,
  selectGridDimensions,
  selectSessionName,
  selectKeyBindings,
} from '../machines/AppContext';
import { buildAnsiStyle } from '../utils/ansiStyles';
import { formatPrefixKey } from './menus/keybindingLabel';
import { isTauri } from '../tmux/adapters';
import type { KeyBindings } from '../machines/types';

function StatusLineHints({ keybindings }: { keybindings: KeyBindings | null }) {
  if (!keybindings) return null;

  const prefix = formatPrefixKey(keybindings.prefix_key);

  const hasNav = ['C-h', 'C-j', 'C-k', 'C-l'].some((key) =>
    keybindings.root_bindings.some((b) => b.key === key && b.command.includes('tmuxy-nav')),
  );

  const hasTabs = keybindings.root_bindings.some(
    (b) => /^C-[0-9]$/.test(b.key) && b.command.includes('select-window'),
  );

  return (
    <span className="statusline-hints">
      <kbd>{prefix}</kbd> prefix
      {hasNav && (
        <>
          {'  '}
          <kbd>ctrl+hjkl</kbd> pane navigation
        </>
      )}
      {hasTabs && (
        <>
          {'  '}
          <kbd>ctrl+[0-9]</kbd> tab navigation
        </>
      )}
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
  const content = useAppSelector(selectStatusLine);
  const commandMode = useAppSelector(selectCommandMode);
  const statusMessage = useAppSelector(selectStatusMessage);
  const { totalWidth, charWidth } = useAppSelector(selectGridDimensions);
  const sessionName = useAppSelector(selectSessionName);
  const keybindings = useAppSelector(selectKeyBindings);
  const send = useAppSend();
  const { isDemo } = useAppConfig();

  const gridPixelWidth = totalWidth * charWidth;

  const renderedContent = useMemo(() => {
    if (!content) return null;

    const parsed = Anser.ansiToJson(content, { use_classes: false });
    return parsed.map((part, index) => {
      const style = buildAnsiStyle(part);
      return (
        <span key={index} style={style}>
          {part.content}
        </span>
      );
    });
  }, [content]);

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

  // Status message: replaces the center area
  const centerContent = statusMessage ? (
    <pre className="tmux-status-bar-content tmux-status-message">{statusMessage.text}</pre>
  ) : content ? (
    <pre className="tmux-status-bar-content">{renderedContent}</pre>
  ) : null;

  return (
    <div className="tmux-status-bar" data-testid="tmux-status-bar">
      <div
        className="tmux-statusline-inner"
        style={gridPixelWidth > 0 ? { width: gridPixelWidth, margin: '0 auto' } : undefined}
      >
        <div className="tmux-statusline-left">
          <StatusLineHints keybindings={keybindings} />
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
