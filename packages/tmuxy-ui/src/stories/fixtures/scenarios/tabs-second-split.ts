import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

/** Two tabs, `main` (@0) and a second (@1, current) split side by side. */
const scenario: Scenario = {
  steps: [
    {
      state: 'second-split',
      run: ['rename-window main', toTmuxCommand(TmuxOp.NewWindow()), 'split-window -h'],
    },
  ],
};
export default scenario;
