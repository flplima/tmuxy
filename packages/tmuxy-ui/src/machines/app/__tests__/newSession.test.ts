/**
 * Session ▸ New Session names the session itself: a memorable name that no
 * running session has, nor a snapshot the switcher offers to restore, and
 * switches to it.
 *
 * `appMachine` is exported with stub actors, so it starts standalone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';
import words from '../../../../../tmuxy-cli/bin/tmuxy/session-names.json';
import type { AppMachineContext } from '../../types/context';

const pairAt = (noun: number) => `${words.adjectives[0]}-${words.nouns[noun]}`;

describe('NEW_SESSION', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switches to a name no session and no snapshot has', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const actor = createActor(appMachine).start();
    actor.send({
      type: 'SESSIONS_UPDATED',
      sessions: [
        { sessionName: 'tmuxy' },
        { sessionName: pairAt(0) },
      ] as AppMachineContext['sessions'],
    });
    actor.send({
      type: 'SNAPSHOTS_UPDATED',
      restorableSessions: [{ name: pairAt(1) }] as AppMachineContext['restorableSessions'],
    });

    actor.send({ type: 'NEW_SESSION' });

    expect(actor.getSnapshot().context.sessionName).toBe(pairAt(2));
    actor.stop();
  });
});
