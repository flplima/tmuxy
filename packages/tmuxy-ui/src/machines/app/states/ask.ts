/**
 * ask state — questions on a pane: pending confirmations raised by
 * `tmuxy pane send -t`, and the questions `tmuxy pane ask` puts.
 *
 * Answering writes a tmux option; moving the highlight is local.
 */

export const askState = {
  on: {
    MOVE_ASK_SELECTION: { actions: 'ask_moveSelection' },
    ANSWER_ASK: { actions: 'ask_answer' },
    ANSWER_QUESTION: { actions: 'ask_answer' },
    ANSWER_VISIBLE_ASKS: { actions: 'ask_answerVisible' },
    ASK_KEY: { actions: 'ask_key' },
  },
} as const;
