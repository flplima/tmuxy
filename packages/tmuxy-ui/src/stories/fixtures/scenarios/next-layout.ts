import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

/** Three panes (`%1` split below), then rearranged by tmux's next layout. */
const scenario: Scenario = {
  steps: [
    { state: 'three', run: ['split-window -h', 'split-window -v'] },
    { state: 'cycled', run: [toTmuxCommand(TmuxOp.SelectLayout({ layout: 'next' }))] },
  ],
};
export default scenario;
