import type { Scenario } from '../scenario';

/**
 * Two panes side by side; then the left one asked to grow far past the
 * window's edge, which tmux answers by leaving the right one at its minimum.
 */
const scenario: Scenario = {
  steps: [
    { state: 'side-by-side', run: ['split-window -h'] },
    { state: 'right-at-minimum', run: ['resize-pane -t %0 -R 500'] },
  ],
};
export default scenario;
