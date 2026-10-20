import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { LEFT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 30;

/**
 * Two panes side by side, then the tree column opened beside them — the
 * client narrowed by the column, as the app narrows it — then hidden again.
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    { state: 'closed', run: ['split-window -h'] },
    {
      state: 'open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: null }))],
    },
    {
      state: 'hidden',
      size: { cols: COLS, rows: ROWS },
      run: ['set-option -w -t :__sidebar-left @tmuxy-sidebar-hidden 1'],
    },
  ],
};
export default scenario;
