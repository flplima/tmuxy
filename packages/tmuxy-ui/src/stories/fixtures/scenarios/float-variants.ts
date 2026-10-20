import type { Scenario } from '../scenario';

/**
 * Every kind of float over one pane, each opened with `tmuxy pane float` typed
 * in %0, in this order (%1 … %7): centred with the dim backdrop, a left
 * drawer with none, a bottom drawer with blur, a right drawer, a top drawer,
 * a centred float with no header, and a centred float 40 columns wide.
 */
const FLOATS = [
  '',
  '--left --width 30 --bg none',
  '--bottom --height 8 --bg blur',
  '--right --width 30',
  '--top --height 6',
  '--hide-header --width 50 --height 6',
  '--width 40 --height 10',
];

const line = FLOATS.map((options) => `tmuxy pane float ${options}`.trim()).join('; ');

const scenario: Scenario = {
  steps: [
    {
      state: 'every-float',
      run: [`send-keys -t %0 -l '${line}'`, 'send-keys -t %0 Enter'],
      // The last float's pane id, which the CLI prints once it is up.
      waitFor: '%7',
    },
  ],
};
export default scenario;
