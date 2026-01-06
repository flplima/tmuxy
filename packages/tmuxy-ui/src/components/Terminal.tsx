import { useMemo, useCallback } from 'react';
import Anser from 'anser';
import { parseRichContent, hasRichContent } from '../utils/richContentParser';
import { RichContentLine } from './RichContent';
import { Cursor } from './Cursor';
import './Terminal.css';

interface TerminalProps {
  content: string[];
  paneId?: number;
  cursorX?: number;
  cursorY?: number;
  isActive?: boolean;
  width?: number;
  height?: number;
  inMode?: boolean; // copy mode
  copyCursorX?: number;
  copyCursorY?: number;
}

export const Terminal: React.FC<TerminalProps> = ({
  content,
  cursorX = 0,
  cursorY = 0,
  isActive = false,
  height = 24,
  inMode = false,
  copyCursorX = 0,
  copyCursorY = 0,
}) => {
  // Use copy mode cursor position when in copy mode
  const effectiveCursorX = inMode ? copyCursorX : cursorX;
  const effectiveCursorY = inMode ? copyCursorY : cursorY;

  // Render ANSI-formatted text with optional cursor
  const renderAnsiText = useCallback(
    (
      text: string,
      lineIndex: number,
      charOffset: number = 0,
      showCursor: boolean = false
    ): React.ReactNode => {
      const parsed = Anser.ansiToJson(text, { use_classes: false });

      return parsed.map((part, partIndex) => {
        // Build inline style from anser output
        const style: React.CSSProperties = {};

        // Check for reverse video (used by tmux for copy mode selection)
        const isReverse = part.decorations.includes('reverse');

        if (isReverse) {
          // Swap foreground and background colors
          if (part.bg) {
            style.color = `rgb(${part.bg})`;
          } else {
            style.color = '#1e1e1e'; // default background as text color
          }
          if (part.fg) {
            style.backgroundColor = `rgb(${part.fg})`;
          } else {
            style.backgroundColor = '#d4d4d4'; // default text as background
          }
        } else {
          if (part.fg) {
            style.color = `rgb(${part.fg})`;
          }
          if (part.bg) {
            style.backgroundColor = `rgb(${part.bg})`;
          }
        }

        if (part.decorations.includes('bold')) {
          style.fontWeight = 'bold';
        }
        if (part.decorations.includes('dim')) {
          style.opacity = 0.5;
        }
        if (part.decorations.includes('italic')) {
          style.fontStyle = 'italic';
        }
        if (part.decorations.includes('underline')) {
          style.textDecoration = 'underline';
        }
        if (part.decorations.includes('blink')) {
          style.animation = 'terminal-blink 1s step-end infinite';
        }
        if (part.decorations.includes('hidden')) {
          style.visibility = 'hidden';
        }
        if (part.decorations.includes('strikethrough')) {
          style.textDecoration = style.textDecoration
            ? `${style.textDecoration} line-through`
            : 'line-through';
        }

        // Check if cursor should be in this part
        if (showCursor && lineIndex === effectiveCursorY) {
          const partText = part.content;
          let charsBefore = charOffset;

          // Calculate characters before this part
          for (let i = 0; i < partIndex; i++) {
            charsBefore += parsed[i].content.length;
          }

          const cursorInThisPart =
            effectiveCursorX >= charsBefore &&
            effectiveCursorX < charsBefore + partText.length;

          if (cursorInThisPart) {
            const localCursorPos = effectiveCursorX - charsBefore;
            const beforeCursor = partText.slice(0, localCursorPos);
            const cursorChar = partText[localCursorPos] || ' ';
            const afterCursor = partText.slice(localCursorPos + 1);

            return (
              <span key={partIndex} style={style}>
                {beforeCursor}
                <Cursor
                  x={effectiveCursorX}
                  y={effectiveCursorY}
                  char={cursorChar}
                  copyMode={inMode}
                  active={isActive}
                />
                {afterCursor}
              </span>
            );
          }
        }

        return (
          <span key={partIndex} style={style}>
            {part.content}
          </span>
        );
      });
    },
    [effectiveCursorX, effectiveCursorY, inMode]
  );

  const renderedLines = useMemo(() => {
    // Ensure we have exactly `height` lines (pad with empty lines if needed)
    const lines = [...content];
    while (lines.length < height) {
      lines.push('');
    }

    return lines.slice(0, height).map((line, lineIndex) => {
      const showCursor = isActive || inMode;

      // Check if line has rich content (images, hyperlinks)
      if (hasRichContent(line)) {
        const richContents = parseRichContent(line);

        // Track character position for cursor
        let charOffset = 0;

        return (
          <div key={lineIndex} className="terminal-line">
            <RichContentLine
              contents={richContents}
              renderText={(text) => {
                const rendered = renderAnsiText(text, lineIndex, charOffset, showCursor);
                // Update charOffset for next text segment
                // Strip ANSI codes to get actual character count
                const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
                charOffset += stripped.length;
                return rendered;
              }}
            />
            {/* Render cursor at end of line if needed */}
            {showCursor &&
              lineIndex === effectiveCursorY &&
              (() => {
                // Calculate total visible character length
                let totalLength = 0;
                for (const content of richContents) {
                  if (content.type === 'text') {
                    const stripped = content.content.replace(/\x1b\[[0-9;]*m/g, '');
                    totalLength += stripped.length;
                  } else if (content.type === 'hyperlink') {
                    const stripped = content.text.replace(/\x1b\[[0-9;]*m/g, '');
                    totalLength += stripped.length;
                  }
                }
                if (effectiveCursorX >= totalLength) {
                  // Pad with spaces to reach cursor position
                  const padding = ' '.repeat(effectiveCursorX - totalLength);
                  return (
                    <>
                      {padding}
                      <Cursor
                        x={effectiveCursorX}
                        y={effectiveCursorY}
                        char=" "
                        copyMode={inMode}
                        active={isActive}
                      />
                    </>
                  );
                }
                return null;
              })()}
          </div>
        );
      }

      // Standard ANSI-only line (optimized path)
      const parsed = Anser.ansiToJson(line, { use_classes: false });

      return (
        <div key={lineIndex} className="terminal-line">
          {parsed.map((part, partIndex) => {
            // Build inline style from anser output
            const style: React.CSSProperties = {};

            // Check for reverse video (used by tmux for copy mode selection)
            const isReverse = part.decorations.includes('reverse');

            if (isReverse) {
              // Swap foreground and background colors
              if (part.bg) {
                style.color = `rgb(${part.bg})`;
              } else {
                style.color = '#1e1e1e'; // default background as text color
              }
              if (part.fg) {
                style.backgroundColor = `rgb(${part.fg})`;
              } else {
                style.backgroundColor = '#d4d4d4'; // default text as background
              }
            } else {
              if (part.fg) {
                style.color = `rgb(${part.fg})`;
              }
              if (part.bg) {
                style.backgroundColor = `rgb(${part.bg})`;
              }
            }

            if (part.decorations.includes('bold')) {
              style.fontWeight = 'bold';
            }
            if (part.decorations.includes('dim')) {
              style.opacity = 0.5;
            }
            if (part.decorations.includes('italic')) {
              style.fontStyle = 'italic';
            }
            if (part.decorations.includes('underline')) {
              style.textDecoration = 'underline';
            }
            if (part.decorations.includes('blink')) {
              style.animation = 'terminal-blink 1s step-end infinite';
            }
            if (part.decorations.includes('hidden')) {
              style.visibility = 'hidden';
            }
            if (part.decorations.includes('strikethrough')) {
              style.textDecoration = style.textDecoration
                ? `${style.textDecoration} line-through`
                : 'line-through';
            }

            // Check if cursor should be in this part
            // Show cursor when pane is active OR when in copy mode
            if (showCursor && lineIndex === effectiveCursorY) {
              const text = part.content;
              let charsBefore = 0;

              // Calculate characters before this part
              for (let i = 0; i < partIndex; i++) {
                charsBefore += parsed[i].content.length;
              }

              const cursorInThisPart =
                effectiveCursorX >= charsBefore && effectiveCursorX < charsBefore + text.length;

              if (cursorInThisPart) {
                const localCursorPos = effectiveCursorX - charsBefore;
                const beforeCursor = text.slice(0, localCursorPos);
                const cursorChar = text[localCursorPos] || ' ';
                const afterCursor = text.slice(localCursorPos + 1);

                return (
                  <span key={partIndex} style={style}>
                    {beforeCursor}
                    <Cursor
                      x={effectiveCursorX}
                      y={effectiveCursorY}
                      char={cursorChar}
                      copyMode={inMode}
                      active={isActive}
                    />
                    {afterCursor}
                  </span>
                );
              }
            }

            return (
              <span key={partIndex} style={style}>
                {part.content}
              </span>
            );
          })}
          {/* Render cursor at end of line if needed */}
          {showCursor &&
            lineIndex === effectiveCursorY &&
            (() => {
              const lineLength = parsed.reduce((sum, p) => sum + p.content.length, 0);
              if (effectiveCursorX >= lineLength) {
                // Pad with spaces to reach cursor position
                const padding = ' '.repeat(effectiveCursorX - lineLength);
                return (
                  <>
                    {padding}
                    <Cursor
                      x={effectiveCursorX}
                      y={effectiveCursorY}
                      char=" "
                      copyMode={inMode}
                      active={isActive}
                    />
                  </>
                );
              }
              return null;
            })()}
        </div>
      );
    });
  }, [content, effectiveCursorX, effectiveCursorY, isActive, height, inMode, renderAnsiText]);

  // Extract first line of content for accessibility description
  const firstLine = content[0]?.replace(/\x1b\[[0-9;]*m/g, '').trim() || '';

  return (
    <div
      className="terminal-container"
      data-testid="terminal"
      data-cursor-x={effectiveCursorX}
      data-cursor-y={effectiveCursorY}
      role="log"
      aria-label={`Terminal output: ${firstLine.slice(0, 50)}${firstLine.length > 50 ? '...' : ''}`}
      aria-live="polite"
    >
      <pre className="terminal-content" aria-hidden="true">{renderedLines}</pre>
    </div>
  );
};
