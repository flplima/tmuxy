import type { Scenario } from '../scenario';

/** Three panes (split right, then below) with `%0` current; then `echo hi` typed into it. */
const scenario: Scenario = {
  steps: [
    { state: 'three-panes', run: ['split-window -h', 'split-window -v', 'select-pane -t %0'] },
    { state: 'typed', run: ["send-keys -t %0 -l 'echo hi'"], waitFor: '$ echo hi' },
  ],
};
export default scenario;
