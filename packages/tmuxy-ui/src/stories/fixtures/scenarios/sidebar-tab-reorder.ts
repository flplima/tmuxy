import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { WindowId } from '../../../domain/ids';
import { LEFT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 30;

/**
 * Two tabs, `one` (@0) and `two` (@1, active), beside the tree column: then
 * `two` moved before `one`, as dragging its row above does.
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    {
      state: 'open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [
        'rename-window one',
        toTmuxCommand(TmuxOp.NewWindow()),
        'rename-window two',
        toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: null })),
      ],
    },
    {
      state: 'reordered',
      run: [
        toTmuxCommand(
          TmuxOp.MoveWindow({
            windowId: WindowId.make('@1'),
            anchorId: WindowId.make('@0'),
            placement: 'before',
          }),
        ),
      ],
    },
  ],
};
export default scenario;
