import type { Scenario } from '../scenario';

/** One tab: a pane, then split beside it (`%1` active), then `%1` split below. */
const scenario: Scenario = {
  steps: [
    { state: 'one' },
    { state: 'side-by-side', run: ['split-window -h'] },
    { state: 'three', run: ['split-window -v'] },
  ],
};
export default scenario;
