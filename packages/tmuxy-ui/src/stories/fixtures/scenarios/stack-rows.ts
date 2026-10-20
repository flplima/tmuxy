import type { Scenario } from '../scenario';
import { SCRIPTS_DIR, TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

/**
 * A stack, as PANE mode's `s` makes one: `%0` turned into a stack with a new
 * row below it (`%1`, active), which leaves only `%1`'s row open and `%0`'s
 * collapsed to its header; then `%0` focused, which opens its row and
 * collapses `%1`'s. The reshaping is the server's, as it is in the app.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'bottom-open',
      // The binding's command, then a line printed in the new row: `run-shell`
      // holds the rest of the list until the script is done, so the line is
      // proof the stack is up.
      run: [
        `run-shell "bash ${SCRIPTS_DIR}/stack new #{pane_id}" \\; send-keys -t %1 -l 'echo ZZ_STACKED_ZZ' \\; send-keys -t %1 Enter`,
      ],
      waitFor: 'ZZ_STACKED_ZZ',
    },
    {
      state: 'top-open',
      run: [toTmuxCommand(TmuxOp.SelectPane({ paneId: PaneId.make('%0') }))],
    },
  ],
};
export default scenario;
