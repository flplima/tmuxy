/**
 * The tmux actor's shell-prompt events (OSC 133): a pane's prompt rows read
 * for its marks and the jump between them, and Copy Last Output. Kept apart
 * from `tmuxActor.ts`, which hands in its own runners.
 */

import type { AnyActorRef } from 'xstate';
import { Effect } from 'effect';
import type { PaneId } from '../../domain/ids';
import type { PromptDirection } from '../../domain/promptMarks';
import type { AdapterError } from '../../infra/transport/AdapterError';
import type { TmuxTransport } from '../../infra/transport/TmuxTransport';
import { withTransport } from './withTransport';
import { copyLastOutput } from './copyLastOutput';

export type PromptEvent =
  /** Read a pane's prompt rows; `jump` rides along to the answer. */
  | { type: 'FETCH_PROMPT_MARKS'; paneId: PaneId; jump?: PromptDirection }
  /** Copy what a pane's newest command printed, and say so. */
  | { type: 'COPY_LAST_OUTPUT'; paneId: PaneId };

/** What the handlers need of the tmux actor. */
export interface PromptRunners {
  run: <T>(
    effect: Effect.Effect<T, AdapterError, TmuxTransport>,
    opts: { onSuccess?: (value: T) => void; logPrefix?: string; silentFail?: boolean },
  ) => void;
  parent: AnyActorRef;
}

/** Read a pane's prompt rows, and answer with the jump that asked. */
export function fetchPromptMarks(
  event: Extract<PromptEvent, { type: 'FETCH_PROMPT_MARKS' }>,
  r: PromptRunners,
): void {
  r.run(
    withTransport((t) => t.call('get_prompt_marks', { paneId: event.paneId })),
    {
      onSuccess: (marks) =>
        r.parent.send({
          type: 'PROMPT_MARKS_LOADED',
          paneId: event.paneId,
          historySize: marks.historySize,
          prompts: marks.prompts,
          jump: event.jump,
        }),
      logPrefix: 'get_prompt_marks',
      // Marks are an extra on a view that works without them; a jump
      // that was asked for is worth saying it failed.
      silentFail: !event.jump,
    },
  );
}

/** Copy what a pane's newest command printed, and say so. */
export function copyLastOutputOf(
  event: Extract<PromptEvent, { type: 'COPY_LAST_OUTPUT' }>,
  r: PromptRunners,
): void {
  r.run(
    withTransport((t) => t.call('get_last_command_output', { paneId: event.paneId })),
    {
      onSuccess: ({ text }) =>
        void copyLastOutput(text, event.paneId).then((notice) =>
          r.parent.send({ type: 'NOTIFY', ...notice }),
        ),
      logPrefix: 'get_last_command_output',
    },
  );
}
