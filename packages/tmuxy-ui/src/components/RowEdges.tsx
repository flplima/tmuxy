/**
 * RowEdges — paints the pane's horizontal padding row by row.
 *
 * Each pane reaches half a separator column past its cells (`.pane-content`'s
 * `--pane-h-padding-left/right`), and a row painted edge to edge — a status
 * line, an editor gutter — stopped that half cell short of the border. The
 * rows cannot paint the padding themselves: the touch-scroll container they
 * live in clips at its own box. This layer is a sibling of that container
 * inside the padded box, so its strips sit in the padding: the left strip in
 * the first cell's background, the right one in the last cell's.
 *
 * Rows are bottom-anchored like the terminal itself (`bottom: 0` in
 * TerminalPane), so strip `i` counts up from the last row.
 */

import { memo } from 'react';
import type { CellLine } from '../tmux/types';
import { rowEdgeBackground } from './terminalRendering';

interface RowEdgesProps {
  lines: CellLine[];
}

export const RowEdges = memo(function RowEdges({ lines }: RowEdgesProps) {
  const strips: React.ReactNode[] = [];
  const count = lines.length;
  for (let i = 0; i < count; i++) {
    const line = lines[i];
    const left = rowEdgeBackground(line[0]?.s);
    const right = rowEdgeBackground(line[line.length - 1]?.s);
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
    <div className="terminal-edges" aria-hidden="true" data-testid="terminal-edges">
      {strips}
    </div>
  );
});
