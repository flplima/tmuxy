import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const pane = PaneId.make('%0');

/** A pane option's payload: JSON, base64-encoded, as `bin/tmuxy/send` writes it. */
function payload(value: object): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

/** Hang `value` on %0, as `tmuxy pane send -t` or a restore does. */
const hang = (value: object) => `set-option -p -t ${pane} @tmuxy-ask ${payload(value)}`;

/** The app dismissing an offer of `command` on %0. */
const dismiss = (command: string) =>
  toTmuxCommand(TmuxOp.AnswerOffer({ paneId: pane, command, run: false }));

/**
 * One pane, %0: asked by `claude` to send `rm -rf dist` and Enter, then that
 * question answered (as the app answers it); then a restore's offer to run
 * `claude --resume abc123`, dismissed; then an offer to run `htop`, dismissed.
 */
const scenario: Scenario = {
  steps: [
    {
      state: 'asked',
      run: [hang({ token: 'tok-3', caller: 'claude', keys: ['rm -rf dist', 'Enter'] })],
    },
    {
      state: 'answered',
      run: [toTmuxCommand(TmuxOp.AnswerAsk({ paneId: pane, token: 'tok-3', answer: 'yes' }))],
    },
    {
      state: 'offered',
      run: [hang({ token: 'restore-%0', kind: 'offer', command: 'claude --resume abc123' })],
    },
    { state: 'offer-dismissed', run: [dismiss('claude --resume abc123')] },
    { state: 'offered-htop', run: [hang({ token: 'restore-%0', kind: 'offer', command: 'htop' })] },
    { state: 'htop-dismissed', run: [dismiss('htop')] },
  ],
};
export default scenario;
