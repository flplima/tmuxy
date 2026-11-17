import type { Scenario } from '../scenario';
import { TmuxOp, toTmuxCommand } from '../../../domain/commands';
import { PaneId } from '../../../domain/ids';

const pane = PaneId.make('%0');

/** A pane option's payload: JSON, base64-encoded, as `tmuxy-core/src/ask/prompt.rs` writes it. */
function payload(value: object): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
}

/** Put a `tmuxy pane ask` question over %0, as the CLI does: the question, then the pane's state. */
const ask = (value: object) => [
  `set-option -p -t ${pane} @tmuxy-ask ${payload({ kind: 'question', caller: 'claude', ...value })}`,
  `set-option -p -t ${pane} @tmuxy-pane-state needs-input`,
];

/**
 * One pane, %0, on the phone's 80 x 24 grid: `claude` asks which way to go
 * with two buttons (the question holding markup, which must show as text),
 * the app answers it and the asker takes the pane's mark down; then a
 * question answered with a line of text.
 */
const scenario: Scenario = {
  cols: 80,
  rows: 24,
  steps: [
    {
      state: 'question-choices',
      run: ask({
        token: 'tok-q',
        question: 'Deploy <b>main</b> to production?',
        choices: ['deploy', 'wait'],
      }),
    },
    {
      state: 'question-answered',
      run: [
        toTmuxCommand(TmuxOp.AnswerAsk({ paneId: pane, token: 'tok-q', answer: 'choice:0' })),
        `set-option -pu -t ${pane} @tmuxy-pane-state`,
      ],
    },
    {
      state: 'question-text',
      run: ask({ token: 'tok-t', question: 'Name the release branch', text: true }),
    },
    {
      state: 'text-answered',
      run: [
        toTmuxCommand(TmuxOp.AnswerAsk({ paneId: pane, token: 'tok-t', answer: 'no' })),
        `set-option -pu -t ${pane} @tmuxy-pane-state`,
      ],
    },
  ],
};
export default scenario;
