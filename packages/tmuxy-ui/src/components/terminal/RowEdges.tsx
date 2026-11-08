/**
 * Paints the pane's horizontal padding (`--pane-h-padding-left/right`, half a
 * separator column) row by row, in the first and last cell's backgrounds, so
 * a status line or an editor gutter reaches the border. The strips hang from
 * the same edge as `.pane-live-screen` (`paneContentAnchor.ts`).
 *
 * The right strip is painted only for a row that reaches the last column:
 * tmux reports a row as long as its content, so the last cell of `▀▀▀▀` drawn
 * eight columns into a pane is artwork, not a bar running off the side.
 */

import { memo } from 'react';
import type { CellLine } from '../../domain/wireCells';
import { rowEdgeBackground } from './cellPaint';

interface RowEdgesProps {
  lines: CellLine[];
  cols: number;
}

export const RowEdges = memo(function RowEdges({ lines, cols }: RowEdgesProps) {
  const strips: React.ReactNode[] = [];
  const count = lines.length;
  for (let i = 0; i < count; i++) {
    const line = lines[i];
    const left = rowEdgeBackground(line[0]?.s);
    const right = line.length >= cols ? rowEdgeBackground(line[line.length - 1]?.s) : undefined;
    if (left === undefined && right === undefined) continue;
    const bottom = `calc(${count - 1 - i} * var(--line-height-terminal))`;
    if (left !== undefined) {
      strips.push(
        <div
          key={`l${i}`}
          className="terminal-edge terminal-edge-left"
          style={{ bottom, backgroundColor: left }}
        />,
      );
    }
    if (right !== undefined) {
      strips.push(
        <div
          key={`r${i}`}
          className="terminal-edge terminal-edge-right"
          style={{ bottom, backgroundColor: right }}
        />,
      );
    }
  }
  if (strips.length === 0) return null;
  return (
    <div
      className="terminal-edges"
      aria-hidden="true"
      data-testid="terminal-edges"
      style={{ height: `calc(${count} * var(--line-height-terminal))` }}
    >
      {strips}
    </div>
  );
});
