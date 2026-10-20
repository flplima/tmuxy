import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { LEFT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 30;

/**
 * A tab `agents` of two panes (%0, %1) beside the tree column: then %0
 * declaring itself working and %1 needing input, then %1 failing — each set
 * the way `tmuxy pane state` sets it.
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    {
      state: 'open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [
        'rename-window agents',
        'split-window -h',
        toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: null })),
      ],
    },
    {
      state: 'declared',
      run: [
        'set-option -p -t %0 @tmuxy-pane-state working',
        'set-option -p -t %1 @tmuxy-pane-state needs-input',
      ],
    },
    { state: 'failed', run: ['set-option -p -t %1 @tmuxy-pane-state error'] },
  ],
};
export default scenario;
