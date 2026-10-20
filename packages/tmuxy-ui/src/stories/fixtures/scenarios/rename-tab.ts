import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { WindowId } from '../../../domain/ids';

const rename = (id: string, name: string) =>
  toTmuxCommand(TmuxOp.RenameWindow({ target: WindowId.make(id), name }));

/**
 * Two tabs, `alpha` (@0) and `bravo` (@1, active); then `alpha` renamed
 * `charlie` from its tab; then `bravo` renamed `nonsense`.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'alpha-bravo',
      run: ['rename-window alpha', toTmuxCommand(TmuxOp.NewWindow()), 'rename-window bravo'],
    },
    { state: 'charlie-bravo', run: [rename('@0', 'charlie')] },
    { state: 'charlie-nonsense', run: [rename('@1', 'nonsense')] },
  ],
};
export default scenario;
