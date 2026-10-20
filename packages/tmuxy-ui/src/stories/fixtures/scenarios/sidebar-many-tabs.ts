import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { LEFT_SIDEBAR_COLS } from '../../../machines/constants';

const COLS = 120;
const ROWS = 20;

/**
 * Twelve tabs of one pane each, `main` (@0) then eleven more with the last
 * active: then the tree column opened beside them, more rows than it is tall.
 */
const scenario: Scenario = {
  cols: COLS,
  rows: ROWS,
  steps: [
    {
      state: 'closed',
      run: [
        'rename-window main',
        ...Array.from({ length: 11 }, () => toTmuxCommand(TmuxOp.NewWindow())),
      ],
    },
    {
      state: 'open',
      size: { cols: COLS - LEFT_SIDEBAR_COLS, rows: ROWS },
      run: [toTmuxCommand(TmuxOp.OpenSidebar({ side: 'left', splitFrom: null }))],
    },
  ],
};
export default scenario;
