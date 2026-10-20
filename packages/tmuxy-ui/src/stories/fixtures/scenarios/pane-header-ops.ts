import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const [p0, p1, p2] = ['%0', '%1', '%2'].map((id) => PaneId.make(id));

/**
 * What a pane's header does to two panes side by side (`%0` left, `%1` right
 * and active): `%1` zoomed by its header, then unzoomed; `%0` split below
 * (`%2` under it); `%0` closed, leaving `%2` beside `%1`; then `%2` dragged
 * onto `%1`, swapping them.
 */
const scenario: Scenario = {
  steps: [
    { state: 'two', run: ['split-window -h'] },
    {
      state: 'zoomed',
      run: [
        toTmuxCommand(TmuxOp.SelectPane({ paneId: p1 })),
        toTmuxCommand(TmuxOp.ZoomToggle({ paneId: p1 })),
      ],
    },
    { state: 'unzoomed', run: [toTmuxCommand(TmuxOp.ZoomToggle({ paneId: p1 }))] },
    {
      state: 'split-below',
      run: [
        toTmuxCommand(TmuxOp.SelectPane({ paneId: p0 })),
        toTmuxCommand(TmuxOp.Split({ direction: 'horizontal' })),
      ],
    },
    { state: 'closed', run: [toTmuxCommand(TmuxOp.KillPane({ paneId: p0 }))] },
    {
      state: 'swapped',
      run: [toTmuxCommand(TmuxOp.Swap({ sourcePaneId: p2, targetPaneId: p1, keepFocus: true }))],
    },
  ],
};
export default scenario;
