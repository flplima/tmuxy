import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

const newTab = toTmuxCommand(TmuxOp.NewWindow());

/** Two tabs, `main` (@0) and `logs` (@1): with `logs` active, then `main`. */
const scenario: Scenario = {
  steps: [
    {
      state: 'logs-active',
      run: ['rename-window main', newTab, 'rename-window logs'],
    },
    { state: 'main-active', run: ['select-window -t @0'] },
  ],
};
export default scenario;
