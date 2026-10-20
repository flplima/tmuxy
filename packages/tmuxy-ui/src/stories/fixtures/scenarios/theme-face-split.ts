import type { Scenario } from '../scenario';

/**
 * A tab named `main` split side by side, the new pane (`%1`, current)
 * having printed `RED196` in 256-colour 196.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'split',
      run: [
        'rename-window main',
        'split-window -h',
        'send-keys -t %1 -l \'printf "\\033[38;5;196m%s%s\\033[0m\\n" RED 196\'',
        'send-keys -t %1 Enter',
      ],
      waitFor: 'RED196',
    },
  ],
};
export default scenario;
