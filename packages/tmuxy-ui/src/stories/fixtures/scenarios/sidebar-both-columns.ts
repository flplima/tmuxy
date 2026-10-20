import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { LEFT_SIDEBAR_COLS, RIGHT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 30;

/**
 * One pane, then the tree column opened at the left, the terminal dock at the
 * right, the tree hidden and the dock hidden after it — the client narrowed by
 * whichever columns are open, as the app narrows it.
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    { state: 'closed' },
    {
      state: 'left-open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: null }))],
    },
    {
      state: 'both-open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS - RIGHT_SIDEBAR_COLS, rows: ROWS },
      run: [toTmuxCommand(TmuxOp.OpenSidebar({ side: 'right', splitFrom: null }))],
    },
    {
      state: 'right-open',
      size: { cols: COLS - RIGHT_SIDEBAR_COLS, rows: ROWS },
      run: ['set-option -w -t :__sidebar-left @tmuxy-sidebar-hidden 1'],
    },
    {
      state: 'both-hidden',
      size: { cols: COLS, rows: ROWS },
      run: ['set-option -w -t :__sidebar-right @tmuxy-sidebar-hidden 1'],
    },
  ],
};
export default scenario;
