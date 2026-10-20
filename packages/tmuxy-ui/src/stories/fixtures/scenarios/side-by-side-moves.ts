import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const p0 = PaneId.make('%0');

/**
 * One pane, then split beside it (`%1` right and active); `%1` swapped with
 * the pane before it, and back; then `%0` focused, and grown 8 columns right.
 */
const scenario: Scenario = {
  steps: [
    { state: 'one' },
    { state: 'two', run: [toTmuxCommand(TmuxOp.Split({ direction: 'vertical' }))] },
    { state: 'swapped', run: [toTmuxCommand(TmuxOp.SwapAdjacent({ direction: 'U' }))] },
    { state: 'swapped-back', run: [toTmuxCommand(TmuxOp.SwapAdjacent({ direction: 'U' }))] },
    { state: 'left-active', run: [toTmuxCommand(TmuxOp.SelectPane({ paneId: p0 }))] },
    {
      state: 'left-grown',
      run: [
        toTmuxCommand(TmuxOp.ResizePanes({ steps: [{ paneId: p0, direction: 'R', cells: 8 }] })),
      ],
    },
  ],
};
export default scenario;
