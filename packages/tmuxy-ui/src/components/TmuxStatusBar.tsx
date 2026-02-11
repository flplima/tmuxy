/**
 * TmuxStatusBar - Renders the tmux status line with ANSI colors
 *
 * Uses hooks to access status line content directly.
 */

import { useMemo } from 'react';
import Anser from 'anser';
import { useAppSelector, selectStatusLine } from '../machines/AppContext';
import { buildAnsiStyle } from '../utils/ansiStyles';

export function TmuxStatusBar() {
  const content = useAppSelector(selectStatusLine);

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

  if (!content) return null;

  return (
    <div className="tmux-status-bar" data-testid="tmux-status-bar">
      <pre className="tmux-status-bar-content">{renderedContent}</pre>
    </div>
  );
}
