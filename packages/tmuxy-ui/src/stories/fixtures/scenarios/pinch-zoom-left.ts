import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const left = PaneId.make('%0');
/** What a pinch over `%0` sends: select it, then toggle the zoom on it. */
const zoomLeft = [
  toTmuxCommand(TmuxOp.SelectPane({ paneId: left })),
  toTmuxCommand(TmuxOp.ZoomToggle({ paneId: left })),
];

/**
 * Two panes side by side (`%1` current); then `%0` zoomed by a pinch; then
 * the same toggle again, back to the split with `%0` current.
 */
const scenario: Scenario = {
  steps: [
    { state: 'side-by-side', run: ['split-window -h'] },
    { state: 'left-zoomed', run: zoomLeft },
    { state: 'left-active', run: zoomLeft },
  ],
};
export default scenario;
