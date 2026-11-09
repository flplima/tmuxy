import { describe, expect, it } from 'vitest';
import { layoutDividers } from '../dividerLayout';
import { bandScope } from '../../machines/resize/limits';
import type { TmuxPane } from '../../domain/client';
import type { PaneId } from '../../domain/ids';
import type { PaneTree } from '../../domain/wire';
import { pid } from '../../test/wire';

const pane = (tmuxId: string, x: number, y: number, width: number, height: number) =>
  ({ tmuxId, x, y, width, height }) as unknown as TmuxPane;

/** The dividers of `panes` under `tree`, as `orientation@line start-end`. */
function dividers(panes: TmuxPane[], tree: PaneTree) {
  const geometry = Object.fromEntries(
    panes.map((p) => [p.tmuxId, { x: p.x, y: p.y, width: p.width, height: p.height }]),
  );
  return layoutDividers(panes, (id: PaneId, handle) => bandScope(geometry, tree, id, handle)).map(
    (d) => `${d.orientation}@${d.axisPos} ${d.start}-${d.end}`,
  );
}

describe('a split column’s dividers', () => {
  // Two columns, the left one split in two: the state a v86 story caught,
  // first as predicted (a placeholder tmux's tree does not have yet), then
  // as tmux confirmed it.
  const before: PaneTree = { vertical: false, children: [pid('%0'), pid('%1')] };
  const predicted = [
    pane('%0', 0, 1, 32, 8),
    pane('%1', 33, 1, 31, 19),
    pane('__placeholder_op_1_2', 0, 10, 32, 10),
  ];
  const confirmed = [pane('%0', 0, 1, 32, 8), pane('%1', 33, 1, 31, 19), pane('%2', 0, 10, 32, 10)];
  const after: PaneTree = {
    vertical: false,
    children: [{ vertical: true, children: [pid('%0'), pid('%2')] }, pid('%1')],
  };

  it('are the same, at the same places, before and after tmux confirms the split', () => {
    // One line between the columns, whole, and the new one inside the left:
    // drawn in two pieces while predicted, it lost a divider when confirmed.
    const expected = ['h@9 0-32', 'v@32 1-20'];
    expect(dividers(predicted, before)).toEqual(expected);
    expect(dividers(confirmed, after)).toEqual(expected);
  });

  it('still keeps two dividers apart where tmux resizes them apart', () => {
    // An even 2×2 grid whose root splits into columns: the row lines of the
    // two columns are separate dividers, though they meet on one line.
    const grid = [
      pane('%0', 0, 0, 40, 10),
      pane('%1', 0, 11, 40, 10),
      pane('%2', 41, 0, 40, 10),
      pane('%3', 41, 11, 40, 10),
    ];
    const tree: PaneTree = {
      vertical: false,
      children: [
        { vertical: true, children: [pid('%0'), pid('%1')] },
        { vertical: true, children: [pid('%2'), pid('%3')] },
      ],
    };
    expect(dividers(grid, tree)).toEqual(['h@10 0-40', 'h@10 41-81', 'v@40 0-21']);
  });
});
