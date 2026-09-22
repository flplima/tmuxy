/**
 * ask state — pending confirmations raised by `tmuxy ask`.
 *
 * Owns context field: askSelections.
 *
 * Answering writes a tmux option, so it is a mutation and a read-only viewer
 * cannot do it — the guard is what stops such a client from predicting an
 * answer the server will refuse. Moving the highlight is local, so it is not
 * guarded: a viewer can read the question and move the cursor over it.
 */

import { notReadOnly } from '../readOnlyGuard';

export const askState = {
  on: {
    MOVE_ASK_SELECTION: { actions: 'ask_moveSelection' },
    ANSWER_ASK: { guard: notReadOnly, actions: 'ask_answer' },
    ANSWER_VISIBLE_ASKS: { guard: notReadOnly, actions: 'ask_answerVisible' },
  },
} as const;
