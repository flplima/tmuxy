import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const [p0, p1] = ['%0', '%1'].map((id) => PaneId.make(id));

/** `echo <marker>` typed into `pane` and run, leaving the marker on its screen. */
const mark = (pane: string, marker: string) => ({
  run: [`send-keys -t ${pane} -l 'echo ${marker}'`, `send-keys -t ${pane} Enter`],
  waitFor: marker,
});

const resize = (direction: 'L' | 'R') =>
  toTmuxCommand(TmuxOp.ResizePanes({ steps: [{ paneId: p1, direction, cells: 5 }] }));
const zoom = toTmuxCommand(TmuxOp.ZoomToggle({ paneId: p1 }));
const swap = toTmuxCommand(TmuxOp.Swap({ sourcePaneId: p0, targetPaneId: p1, keepFocus: false }));

/**
 * A marker line in each of two panes, and what tmux does to them: `ZZ_A_ZZ`
 * in `%0`; split beside it (`%1`, active); `ZZ_B_ZZ` in `%1`; `%1` grown 5
 * columns left four times (`left-5` … `left-20`), then 5 right four times
 * (`back-15` … `back-0`); zoomed and unzoomed; swapped with `%0` and back;
 * then killed.
 */
const scenario: Scenario = {
  steps: [
    { state: 'one', ...mark('%0', 'ZZ_A_ZZ') },
    { state: 'split', run: [toTmuxCommand(TmuxOp.Split({ direction: 'vertical' }))] },
    { state: 'two', ...mark('%1', 'ZZ_B_ZZ') },
    ...[5, 10, 15, 20].map((cells) => ({ state: `left-${cells}`, run: [resize('L')] })),
    ...[15, 10, 5, 0].map((cells) => ({ state: `back-${cells}`, run: [resize('R')] })),
    { state: 'zoomed', run: [zoom] },
    { state: 'unzoomed', run: [zoom] },
    { state: 'swapped', run: [swap] },
    { state: 'swapped-back', run: [swap] },
    { state: 'killed', run: [toTmuxCommand(TmuxOp.KillPane({ paneId: p1 }))] },
  ],
};
export default scenario;
