import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { WindowId } from '../../../domain/ids';

/**
 * One tab (@0); a second (@1) made the way the strip makes one and left
 * current; @1 closed again; then two tabs again (@2 current), and the first
 * made current by `next-window` wrapping round.
 */
const scenario: Scenario = {
  steps: [
    { state: 'one-tab' },
    { state: 'two-tabs', run: [toTmuxCommand(TmuxOp.NewWindow())] },
    {
      state: 'closed',
      run: [toTmuxCommand(TmuxOp.KillWindow({ windowId: WindowId.make('@1') }))],
    },
    { state: 'second-active', run: [toTmuxCommand(TmuxOp.NewWindow())] },
    { state: 'first-active', run: ['next-window'] },
  ],
};
export default scenario;
