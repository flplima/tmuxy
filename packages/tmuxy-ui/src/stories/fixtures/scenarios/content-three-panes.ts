import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

/** `echo <marker>` typed into `pane` and run, leaving the marker on its screen. */
const mark = (pane: string, marker: string) => [
  `send-keys -t ${pane} -l 'echo ${marker}'`,
  `send-keys -t ${pane} Enter`,
];

const select = (id: string) => toTmuxCommand(TmuxOp.SelectPane({ paneId: PaneId.make(id) }));

/**
 * Three panes, each with a marker line: `ZZ_NAV_A_ZZ` in `%0`, split beside
 * it for `ZZ_NAV_B_ZZ` in `%1`, split below that for `ZZ_NAV_C_ZZ` in `%2`;
 * then each pane focused in turn.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'three',
      run: [
        ...mark('%0', 'ZZ_NAV_A_ZZ'),
        toTmuxCommand(TmuxOp.Split({ direction: 'vertical' })),
        ...mark('%1', 'ZZ_NAV_B_ZZ'),
        toTmuxCommand(TmuxOp.Split({ direction: 'horizontal' })),
        ...mark('%2', 'ZZ_NAV_C_ZZ'),
      ],
      waitFor: 'ZZ_NAV_C_ZZ',
    },
    { state: 'at-0', run: [select('%0')] },
    { state: 'at-1', run: [select('%1')] },
    { state: 'at-2', run: [select('%2')] },
  ],
};
export default scenario;
