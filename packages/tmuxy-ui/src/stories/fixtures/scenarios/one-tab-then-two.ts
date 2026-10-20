import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

/**
 * One tab (@0), then a second (@1) made the way the strip's "+" makes it and
 * left current, then back on the first.
 */
const scenario: Scenario = {
  steps: [
    { state: 'one-tab' },
    { state: 'two-tabs', run: [toTmuxCommand(TmuxOp.NewWindow())] },
    { state: 'first-active', run: ['select-window -t @0'] },
  ],
};
export default scenario;
