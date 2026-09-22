/**
 * Action implementations for pending confirmations (`tmuxy ask`).
 *
 * Owns context field: askSelections.
 *
 * A question lives on the pane itself, as the `@tmuxy-ask` tmux option — so
 * every client attached to the session sees the same question, and answering
 * it in one is answering it in all of them. Nothing here holds the question:
 * the only client-side state is which of Yes/No is highlighted, and that is
 * here rather than in the overlay component because the keyboard actor moves
 * it too, from outside React.
 *
 * See `utils/paneAsk.ts` for the wire format and `bin/tmuxy/ask` for the other
 * end of it.
 */

import { assign, enqueueActions, sendTo } from 'xstate';
import type { AppMachineContext, AllAppMachineEvents } from '../../types';
import { answerAskCommand, paneAskFor, type AskAnswer } from '../../../utils/paneAsk';
import { visibleFloats } from '../../selectors';

type Ctx = AppMachineContext;
type Evt = AllAppMachineEvents;

/** The highlighted option for a pane — `yes` until the user moves it. */
export function askSelectionFor(context: Ctx, paneId: string): AskAnswer {
  return context.askSelections[paneId] ?? 'yes';
}

/**
 * Drop highlight entries for panes that no longer have a question, so a pane
 * asked twice does not start the second question on the first one's answer.
 */
export function pruneAskSelections(context: Ctx): Record<string, AskAnswer> {
  const asking = new Set(context.panes.filter((pane) => paneAskFor(pane)).map((p) => p.tmuxId));
  const kept: Record<string, AskAnswer> = {};
  for (const [paneId, answer] of Object.entries(context.askSelections)) {
    if (asking.has(paneId)) kept[paneId] = answer;
  }
  return kept;
}

export const askActions = {
  ask_moveSelection: assign<Ctx, Evt, undefined, Evt, never>(({ context, event }) => {
    if (event.type !== 'MOVE_ASK_SELECTION') return {};
    if (askSelectionFor(context, event.paneId) === event.to) return {};
    return { askSelections: { ...context.askSelections, [event.paneId]: event.to } };
  }),

  ask_answer: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'ANSWER_ASK') return;
      const pane = context.panes.find((p) => p.tmuxId === event.paneId);
      const ask = paneAskFor(pane);
      // No question means there is nothing to answer: the user clicked as the
      // asker withdrew it, or a second client answered first.
      if (!ask) return;
      enqueue(
        sendTo('tmux', {
          type: 'SEND_COMMAND' as const,
          command: answerAskCommand(event.paneId, ask, event.answer),
        }),
      );
      enqueue.assign(({ context: ctx }) => {
        const { [event.paneId]: _answered, ...rest } = ctx.askSelections;
        return { askSelections: rest };
      });
    },
  ),

  ask_answerVisible: enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>(
    ({ context, event, enqueue }) => {
      if (event.type !== 'ANSWER_VISIBLE_ASKS') return;
      // What the user can SEE: the active tab's panes, plus the floats drawn
      // over it (a float lives in a window of its own, so a windowId test
      // alone would skip one the user is looking straight at). A shortcut
      // that reached questions in other tabs would answer things off screen,
      // which is the one thing the confirmation exists to prevent.
      const onScreen = new Set(
        visibleFloats(context.floatPanes, context.windows, context.activeWindowId).map(
          (float) => float.paneId,
        ),
      );
      for (const pane of context.panes) {
        if (pane.windowId !== context.activeWindowId && !onScreen.has(pane.tmuxId)) continue;
        if (!paneAskFor(pane)) continue;
        enqueue.raise({
          type: 'ANSWER_ASK' as const,
          paneId: pane.tmuxId,
          answer: event.answer,
        });
      }
    },
  ),
};
