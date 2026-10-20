import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';
import { LEFT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 30;
const left = PaneId.make('%0');

/**
 * Two panes side by side with %1 active, then %0 selected, then the tree
 * column opened beside them (the client narrowed by the column, as the app
 * narrows it).
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    { state: 'right-active', run: ['split-window -h'] },
    { state: 'left-active', run: [toTmuxCommand(TmuxOp.SelectPane({ paneId: left }))] },
    {
      state: 'tree-open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: left }))],
    },
  ],
};
export default scenario;
