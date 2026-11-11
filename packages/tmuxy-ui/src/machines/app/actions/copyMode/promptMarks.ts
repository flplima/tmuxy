/**
 * The shell's prompts in a pane's scrollback (OSC 133): going to the
 * previous or next one, and copying what the newest command printed. The
 * rows come from tmux through the host; a view keeps them as `promptRows`.
 * See docs/COPY-MODE.md.
 */

import { assign, sendTo } from 'xstate';
import { act, type Ctx, type Enqueue } from '../../actionTypes';
import type { CopyModeState } from '../../../../domain/copyMode';
import type { PaneId } from '../../../../domain/ids';
import {
  jumpToPrompt,
  promptFrom,
  shiftPromptRows,
  type PromptDirection,
} from '../../../../domain/promptMarks';
import { selectKeyFocusPane } from '../../../selectors/keyboard';
import { buildScrollbackState, fetchHistory, fetchNeededChunk } from './scrollback';

const NO_PROMPT = {
  previous: 'No prompt above',
  next: 'No prompt below',
} as const;

/** Move an open view to the prompt, or leave it for the live screen. */
function jumpInView(
  enqueue: Enqueue,
  context: Ctx,
  paneId: PaneId,
  view: CopyModeState,
  direction: PromptDirection,
): void {
  const jump = jumpToPrompt(view, direction);
  if (jump === null) {
    enqueue.raise({ type: 'NOTIFY', kind: 'info', text: NO_PROMPT[direction] });
    return;
  }
  if (jump.kind === 'leave') {
    enqueue.raise({ type: 'EXIT_SCROLL_MODE', paneId });
    return;
  }
  const moved: CopyModeState = { ...view, ...jump.state };
  enqueue(assign({ copyModeStates: { ...context.copyModeStates, [paneId]: moved } }));
  fetchNeededChunk(enqueue, context, paneId, moved);
}

export const promptMarkActions = {
  /**
   * A view that has its rows moves at once. A pane with no view asks tmux
   * first, and the answer opens the scroll view at the prompt: opening it
   * before would show the bottom and then leap.
   */
  promptMarks_jump: act(({ event, context, enqueue }) => {
    if (event.type !== 'PROMPT_JUMP') return;
    const paneId = event.paneId ?? selectKeyFocusPane(context);
    if (!paneId) return;
    const view = context.copyModeStates[paneId];
    if (view?.promptRows) {
      jumpInView(enqueue, context, paneId, view, event.direction);
      return;
    }
    enqueue(sendTo('tmux', { type: 'FETCH_PROMPT_MARKS' as const, paneId, jump: event.direction }));
  }),

  promptMarks_loaded: act(({ event, context, enqueue }) => {
    if (event.type !== 'PROMPT_MARKS_LOADED') return;
    const { paneId, jump } = event;
    const view = context.copyModeStates[paneId];
    if (view) {
      const promptRows = shiftPromptRows(event.prompts, view.historySize - event.historySize);
      const marked: CopyModeState = { ...view, promptRows };
      const copyModeStates = { ...context.copyModeStates, [paneId]: marked };
      enqueue(assign({ copyModeStates }));
      if (jump) jumpInView(enqueue, { ...context, copyModeStates }, paneId, marked, jump);
      return;
    }
    if (!jump) return;

    const pane = context.panes.find((p) => p.tmuxId === paneId);
    // A full-screen application or a tmux mode owns the screen: there is no
    // scrollback behind it to go to (the gate the wheel and select-all use).
    if (!pane || pane.alternateOn || pane.inMode) return;
    const record = buildScrollbackState(pane, 'scroll', {});
    const promptRows = shiftPromptRows(event.prompts, record.historySize - event.historySize);
    const target = promptFrom(promptRows, record.scrollTop, jump);
    if (target === null || target >= record.scrollTop) {
      enqueue.raise({ type: 'NOTIFY', kind: 'info', text: NO_PROMPT[jump] });
      return;
    }
    const opened: CopyModeState = { ...record, promptRows, scrollTop: target };
    enqueue(assign({ copyModeStates: { ...context.copyModeStates, [paneId]: opened } }));
    fetchHistory(enqueue, paneId, opened);
  }),

  promptMarks_copyLastOutput: act(({ event, context, enqueue }) => {
    if (event.type !== 'COPY_LAST_OUTPUT') return;
    const paneId = event.paneId ?? selectKeyFocusPane(context);
    if (paneId) enqueue(sendTo('tmux', { type: 'COPY_LAST_OUTPUT' as const, paneId }));
  }),
};
