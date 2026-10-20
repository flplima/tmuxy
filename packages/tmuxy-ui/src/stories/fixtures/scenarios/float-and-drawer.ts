import type { Scenario } from '../scenario';

/** `command` typed into `%0` and run, as a user runs it at the prompt. */
const typed = (command: string) => [`send-keys -t %0 -l '${command}'`, 'send-keys -t %0 Enter'];

/**
 * One pane; then `tmuxy pane float` run in it (a centred float, `%1`); the
 * float closed; then `tmuxy pane float --left --width 40` (a left drawer, `%2`).
 */
const scenario: Scenario = {
  steps: [
    { state: 'one' },
    // The CLI prints the float's pane id once it is up.
    { state: 'float', run: typed('tmuxy pane float'), waitFor: '%1' },
    { state: 'float-closed', run: ['kill-pane -t %1'] },
    { state: 'drawer', run: typed('tmuxy pane float --left --width 40'), waitFor: '%2' },
  ],
};
export default scenario;
