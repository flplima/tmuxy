import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { LEFT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 30;

/**
 * Two tabs of two panes each, `one` (@0: %0, %1) and `two` (@1: %2, %3), with
 * `two` active: then the tree column opened beside them (its window @2), the
 * first tab picked, its other pane picked, and the column hidden again.
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    {
      state: 'closed',
      run: [
        'rename-window one',
        'split-window -h',
        toTmuxCommand(TmuxOp.NewWindow()),
        'rename-window two',
        'split-window -h',
      ],
    },
    {
      state: 'open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: null }))],
    },
    { state: 'one-active', run: ['select-window -t @0'] },
    { state: 'pane-picked', run: ['select-pane -t %0'] },
    {
      state: 'hidden',
      size: { cols: COLS, rows: ROWS },
      run: ['set-option -w -t :__sidebar-left @tmuxy-sidebar-hidden 1'],
    },
  ],
};
export default scenario;
