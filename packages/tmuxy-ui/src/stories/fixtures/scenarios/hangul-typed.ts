import type { Scenario } from '../scenario';

/** One pane; then `한글` typed at its prompt; then `ab` after it. */
const scenario: Scenario = {
  steps: [
    { state: 'one' },
    { state: 'hangul', run: ["send-keys -t %0 -l '한글'"], waitFor: '한' },
    { state: 'hangul-ab', run: ["send-keys -t %0 -l 'ab'"], waitFor: 'ab' },
  ],
};
export default scenario;
