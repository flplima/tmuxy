/**
 * Session ▸ New Session names the session itself: a memorable name that no
 * running session has, nor a snapshot the switcher offers to restore, and
 * switches to it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { startApp } from '../../../test/app';
import words from '../../../../../tmuxy-cli/bin/tmuxy/session-names.json';
import type { AppMachineContext } from '../../types/context';

/** The names a draw that always comes up first would try first. */
const first = `${words.adjectives[0]}-${words.nouns[0]}`;
const second = `${words.adjectives[0]}-${words.nouns[1]}`;

describe('NEW_SESSION', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('switches to a name no session and no snapshot has', () => {
    // Every draw comes up first, so the names taken are the ones it meets.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const actor = startApp({ connected: false });
    actor.send({
      type: 'SESSIONS_UPDATED',
      sessions: [{ sessionName: 'tmuxy' }, { sessionName: first }] as AppMachineContext['sessions'],
    });
    actor.send({
      type: 'SNAPSHOTS_UPDATED',
      restorableSessions: [{ name: second }] as AppMachineContext['restorableSessions'],
    });

    actor.send({ type: 'NEW_SESSION' });

    const name = actor.getSnapshot().context.sessionName;
    expect(['tmuxy', first, second]).not.toContain(name);
    const [adjective, noun] = name.split('-');
    expect(words.adjectives).toContain(adjective);
    expect(words.nouns).toContain(noun);
    actor.stop();
  });
});
