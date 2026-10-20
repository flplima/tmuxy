import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

/** The phone's 80 x 24 grid: two tabs, `main` (@0, current) and `logs` (@1). */
const scenario: Scenario = {
  cols: 80,
  rows: 24,
  steps: [
    {
      state: 'main-active',
      run: [
        'rename-window main',
        toTmuxCommand(TmuxOp.NewWindow()),
        'rename-window logs',
        'select-window -t @0',
      ],
    },
  ],
};
export default scenario;
