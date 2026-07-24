import { createActor, fromCallback, type AnyActorRef } from 'xstate';
import { describe, expect, it, vi } from 'vitest';
import type { TmuxActorEvent } from '../../actors/tmuxActor';
import { appMachine } from '../appMachine';

describe('appMachine session switching', () => {
  it('forwards an optional window and pane target to the tmux actor', async () => {
    const tmuxEvents: TmuxActorEvent[] = [];
    const machine = appMachine.provide({
      actors: {
        tmuxActor: fromCallback<TmuxActorEvent, { parent: AnyActorRef }>(({ receive }) => {
          receive((event) => tmuxEvents.push(event));
          return () => {};
        }),
      },
    });
    const actor = createActor(machine);
    actor.start();

    actor.send({
      type: 'SWITCH_SESSION',
      sessionName: 'review',
      windowId: '@9',
      paneId: '%9',
    });

    await vi.waitFor(() => {
      expect(tmuxEvents).toContainEqual({
        type: 'SWITCH_SESSION',
        sessionName: 'review',
        windowId: '@9',
        paneId: '%9',
      });
    });
    actor.stop();
  });
});
