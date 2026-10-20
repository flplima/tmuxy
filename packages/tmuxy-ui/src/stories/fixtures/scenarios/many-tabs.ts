import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';

const newTab = toTmuxCommand(TmuxOp.NewWindow());

/**
 * Twelve tabs, more than a strip shows at once: `development` (@0) and
 * `long-tab-name-1` … `long-tab-name-11` (@1 … @11). With the last active,
 * then the first.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'last-active',
      run: [
        'rename-window development',
        ...Array.from({ length: 11 }, (_, i) => [
          newTab,
          `rename-window long-tab-name-${i + 1}`,
        ]).flat(),
      ],
    },
    { state: 'first-active', run: ['select-window -t @0'] },
  ],
};
export default scenario;
