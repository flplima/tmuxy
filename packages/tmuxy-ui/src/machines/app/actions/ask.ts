/**
 * Action implementations for pending confirmations (`tmuxy pane send -t`).
 *
 * A question lives on the pane itself, as the `@tmuxy-ask` tmux option — so
 * every client attached to the session sees the same question, and answering
 * it in one is answering it in all of them. Nothing here holds the question:
 * the only client-side state is which of Yes/No is highlighted, and that is
 * here rather than in the overlay component because the keyboard actor moves
 * it too, from outside React.
 *
 * See `domain/paneAsk.ts` for the wire format and `packages/tmuxy-cli/bin/tmuxy/ask` for the other
 * end of it.
 */

import { sendTo } from 'xstate';
import { act, assignCtx, type Ctx } from '../actionTypes';
import { paneAskFor, type AskAnswer } from '../../../domain/paneAsk';
import { TmuxOp } from '../../../domain/commands';
import { selectVisibleSendAsks } from '../../selectors/keyboard';
import type { PaneId } from '../../../domain/ids';

export function askSelectionFor(context: Ctx, paneId: PaneId): AskAnswer {
  return context.askSelections[paneId] ?? 'yes';
}

/**
 * Drop highlight entries for panes that no longer have a question, so a pane
 * asked twice does not start the second question on the first one's answer.
 */
export function pruneAskSelections(context: Ctx): Record<PaneId, AskAnswer> {
  const kept: Record<PaneId, AskAnswer> = {};
  for (const pane of context.panes) {
    const answer = context.askSelections[pane.tmuxId];
    if (answer !== undefined && paneAskFor(pane)) kept[pane.tmuxId] = answer;
  }
  return kept;
}

export const askActions = {
  ask_moveSelection: assignCtx(({ context, event }) => {
    if (event.type !== 'MOVE_ASK_SELECTION') return {};
    if (askSelectionFor(context, event.paneId) === event.to) return {};
    return { askSelections: { ...context.askSelections, [event.paneId]: event.to } };
  }),

  ask_answer: act(({ context, event, enqueue }) => {
    if (event.type !== 'ANSWER_ASK') return;
    const pane = context.panes.find((p) => p.tmuxId === event.paneId);
    const ask = paneAskFor(pane);
    // No question means there is nothing to answer: the user clicked as the
    // asker withdrew it, or a second client answered first.
    if (!ask) return;
    enqueue(
      sendTo('tmux', {
        type: 'SEND_OP' as const,
        op:
          ask.kind === 'offer'
            ? TmuxOp.AnswerOffer({
                paneId: event.paneId,
                command: ask.command,
                run: event.answer === 'yes',
              })
            : TmuxOp.AnswerAsk({ paneId: event.paneId, token: ask.token, answer: event.answer }),
      }),
    );
    enqueue.assign(({ context: ctx }) => {
      const { [event.paneId]: _answered, ...rest } = ctx.askSelections;
      return { askSelections: rest };
    });
  }),

  ask_answerVisible: act(({ context, event, enqueue }) => {
    if (event.type !== 'ANSWER_VISIBLE_ASKS') return;
    // What the user can SEE: a shortcut that reached questions in other tabs
    // would answer things off screen, which is the one thing the confirmation
    // exists to prevent. Sends only: allowing what an agent asked is the
    // shortcut's job, and re-running every restored program at once is not.
    for (const paneId of selectVisibleSendAsks(context)) {
      enqueue.raise({ type: 'ANSWER_ASK' as const, paneId, answer: event.answer });
    }
  }),

  /** A plain key typed into a pane with a question on it. */
  ask_key: act(({ context, event, enqueue }) => {
    if (event.type !== 'ASK_KEY') return;
    const { paneId, key } = event;
    const ask = paneAskFor(context.panes.find((p) => p.tmuxId === paneId));
    if (!ask) return;
    const answer = (choice: AskAnswer) =>
      enqueue.raise({ type: 'ANSWER_ASK' as const, paneId, answer: choice });
    const move = (to: AskAnswer) =>
      enqueue.raise({ type: 'MOVE_ASK_SELECTION' as const, paneId, to });
    if (ask.kind === 'offer') {
      answer(key === 'Enter' ? 'yes' : 'no');
      return;
    }
    switch (key) {
      case 'ArrowUp':
      case '1':
        return move('yes');
      case 'ArrowDown':
      case '2':
        return move('no');
      case 'Escape':
        return answer('no');
      case 'Enter':
        return answer(askSelectionFor(context, paneId));
    }
  }),
};
