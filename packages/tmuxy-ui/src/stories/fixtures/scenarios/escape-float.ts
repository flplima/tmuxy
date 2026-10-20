import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

/**
 * One pane (`%0`) that opens a float by typing `tmuxy pane float` (its shell
 * is `%1`), then the float closed the way the app closes one.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'float-open',
      // The echo's output, not its own spelling, shows the float has opened.
      run: ["send-keys -t %0 -l 'tmuxy pane float; echo FLOAT_$((1+1))'", 'send-keys -t %0 Enter'],
      waitFor: 'FLOAT_2',
    },
    {
      state: 'float-closed',
      run: [toTmuxCommand(TmuxOp.KillPane({ paneId: PaneId.make('%1') }))],
    },
  ],
};
export default scenario;
