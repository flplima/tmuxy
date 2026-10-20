import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

/** Two panes side by side (`%1` active); then `%0` titled `build watch`. */
const scenario: Scenario = {
  steps: [
    { state: 'two', run: [toTmuxCommand(TmuxOp.Split({ direction: 'vertical' }))] },
    {
      state: 'titled',
      run: [
        toTmuxCommand(TmuxOp.SetPaneTitle({ paneId: PaneId.make('%0'), title: 'build watch' })),
      ],
    },
  ],
};
export default scenario;
