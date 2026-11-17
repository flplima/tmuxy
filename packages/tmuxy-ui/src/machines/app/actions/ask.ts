/**
 * Action implementations for questions on a pane: pending confirmations
 * (`tmuxy pane send -t`), a restore's offers, and the questions a script or
 * an agent asks the person (`tmuxy pane ask`).
 *
 * A question lives on the pane itself, as the `@tmuxy-ask` tmux option — so
 * every client attached to the session sees the same question, and answering
 * it in one is answering it in all of them. Nothing here holds the question:
 * the only client-side state is which answer is highlighted, and that is
 * here rather than in the overlay component because the keyboard actor moves
 * it too, from outside React.
 *
 * See `domain/paneAsk.ts` for the wire format and `packages/tmuxy-core/src/ask.rs`
 * for the other end of it.
 */

import { sendTo } from 'xstate';
import { act, assignCtx, type Ctx } from '../actionTypes';
import {
  askAnswerCount,
  askSelection,
  paneAskFor,
  questionAnswer,
  SEND_ANSWERS,
} from '../../../domain/paneAsk';
import { TmuxOp } from '../../../domain/commands';
import { selectVisibleSendAsks } from '../../selectors/keyboard';
import type { PaneId } from '../../../domain/ids';

/**
 * Drop highlight entries for panes that no longer have a question, so a pane
 * asked twice does not start the second question on the first one's answer.
 */
export function pruneAskSelections(context: Ctx): Record<PaneId, number> {
  const kept: Record<PaneId, number> = {};
  for (const pane of context.panes) {
    const answer = context.askSelections[pane.tmuxId];
    if (answer !== undefined && paneAskFor(pane)) kept[pane.tmuxId] = answer;
  }
  return kept;
}

/** The question on `paneId`, if it still has one. */
function askOn(context: Ctx, paneId: PaneId) {
  return paneAskFor(context.panes.find((p) => p.tmuxId === paneId));
}

export const askActions = {
  ask_moveSelection: assignCtx(({ context, event }) => {
    if (event.type !== 'MOVE_ASK_SELECTION') return {};
    if (context.askSelections[event.paneId] === event.to) return {};
    return { askSelections: { ...context.askSelections, [event.paneId]: event.to } };
  }),

  ask_answer: act(({ context, event, enqueue }) => {
    if (event.type !== 'ANSWER_ASK' && event.type !== 'ANSWER_QUESTION') return;
    const ask = askOn(context, event.paneId);
    // No question means there is nothing to answer: the user clicked as the
    // asker withdrew it, or a second client answered first.
    if (!ask) return;
    let op: TmuxOp;
    if (event.type === 'ANSWER_QUESTION') {
      if (ask.kind !== 'question') return;
      op = TmuxOp.AnswerAsk({
        paneId: event.paneId,
        token: ask.token,
        answer: questionAnswer(event.reply),
      });
    } else if (ask.kind === 'offer') {
      op = TmuxOp.AnswerOffer({
        paneId: event.paneId,
        command: ask.command,
        run: event.answer === 'yes',
      });
    } else if (ask.kind === 'send') {
      op = TmuxOp.AnswerAsk({ paneId: event.paneId, token: ask.token, answer: event.answer });
    } else {
      return;
    }
    enqueue(sendTo('tmux', { type: 'SEND_OP' as const, op }));
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

  /**
   * A plain key typed into a pane with a question on it. An offer: Enter
   * runs it, anything else drops it. A send or a question with buttons: ↑/↓
   * or a digit move the highlight, Enter takes it, Escape declines. A text
   * question's keys are its field's; one that reaches the pane is claimed,
   * and Escape still dismisses.
   */
  ask_key: act(({ context, event, enqueue }) => {
    if (event.type !== 'ASK_KEY') return;
    const { paneId, key } = event;
    const ask = askOn(context, paneId);
    if (!ask) return;
    if (ask.kind === 'offer') {
      enqueue.raise({
        type: 'ANSWER_ASK' as const,
        paneId,
        answer: key === 'Enter' ? 'yes' : 'no',
      });
      return;
    }
    const pick = (index: number | null) =>
      enqueue.raise(
        ask.kind === 'send'
          ? {
              type: 'ANSWER_ASK' as const,
              paneId,
              answer: index === null ? 'no' : SEND_ANSWERS[index],
            }
          : {
              type: 'ANSWER_QUESTION' as const,
              paneId,
              reply: index === null ? 'dismiss' : { choice: index },
            },
      );
    if (key === 'Escape') return pick(null);
    if (ask.kind === 'question' && ask.text) return;
    const count = askAnswerCount(ask);
    const selected = askSelection(context.askSelections, paneId, count);
    const move = (to: number) => enqueue.raise({ type: 'MOVE_ASK_SELECTION' as const, paneId, to });
    if (key === 'Enter') return pick(selected);
    if (key === 'ArrowUp') return move(Math.max(0, selected - 1));
    if (key === 'ArrowDown') return move(Math.min(count - 1, selected + 1));
    if (/^[1-9]$/.test(key) && Number(key) <= count) move(Number(key) - 1);
  }),
};
