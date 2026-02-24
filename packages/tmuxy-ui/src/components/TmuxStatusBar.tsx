/**
 * TmuxStatusBar - Renders the tmux status line with ANSI colors
 *
 * Three modes:
 * 1. Command mode: shows command prompt input (like tmux prefix+:)
 * 2. Status message: shows temporary message (from display-message)
 * 3. Default: renders tmux status line with ANSI colors
 */

import { useMemo, useRef, useEffect, useCallback } from 'react';
import Anser from 'anser';
import {
  useAppSelector,
  useAppSend,
  selectStatusLine,
  selectCommandMode,
  selectStatusMessage,
  selectGridDimensions,
} from '../machines/AppContext';
import { buildAnsiStyle } from '../utils/ansiStyles';

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
    <div className="tmuxy-tmux-status tmuxy-command-mode" data-testid="tmuxy-command-mode">
      <div className="tmuxy-command-input-wrapper" style={{ width: gridWidth }}>
        <span className="tmuxy-command-prompt">{prompt}</span>
        <input
          ref={inputRef}
          className="tmuxy-command-input"
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
  const send = useAppSend();

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

  // Command mode: show input
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

  // Status message: show temporary message
  if (statusMessage) {
    return (
      <div className="tmuxy-tmux-status tmuxy-status-message" data-testid="tmuxy-status-message">
        <pre className="tmuxy-tmux-status-content">{statusMessage.text}</pre>
      </div>
    );
  }

  // Default: render tmux status line
  if (!content) return null;

  return (
    <div className="tmuxy-tmux-status" data-testid="tmuxy-tmux-status">
      <pre className="tmuxy-tmux-status-content">{renderedContent}</pre>
    </div>
  );
}
