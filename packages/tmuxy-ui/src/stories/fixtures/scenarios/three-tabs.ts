import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

const newTab = toTmuxCommand(TmuxOp.NewWindow());

/**
 * Three tabs, `alpha` (@0), `bravo` (@1) and `charlie` (@2), each its own
 * pane: with `charlie` active, then `alpha`, then with `bravo` killed.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'charlie-active',
      run: ['rename-window alpha', newTab, 'rename-window bravo', newTab, 'rename-window charlie'],
    },
    { state: 'alpha-active', run: ['select-window -t @0'] },
    { state: 'bravo-killed', run: ['kill-window -t @1'] },
  ],
};
export default scenario;
