/**
 * Getting back in after a deliberate detach.
 *
 * The bug this pins: the app stayed in `detached` — blurred, overlay up — over
 * a connection that had already come back. `TMUX_CONNECTED` fires exactly once,
 * from the tmux actor's initial `connect()`, so a monitor that parked on detach
 * and later revived never produced it again. The adapter reports that revival
 * as a recovery (`TMUX_RECONNECTED`) once server state starts flowing, and
 * before the fix nothing in `detached` listened for it, leaving no way out of
 * the overlay short of relaunching the app.
 *
 * `appMachine` is exported with stub actors, so it starts standalone — no
 * adapter, no tmux.
 */

import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { appMachine } from '../appMachine';

/** A machine parked in `detached`, the way a user detach leaves it. */
const detachedActor = () => {
  const actor = createActor(appMachine).start();
  actor.send({ type: 'TMUX_DETACHED', reason: 'detached' });
  return actor;
};

describe('detached state', () => {
  it('a deliberate detach parks the UI instead of retrying', () => {
    const actor = detachedActor();
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('detached');
    // Nothing is being retried, and the stale layout must not animate.
    expect(snapshot.context.connected).toBe(false);
    expect(snapshot.context.enableAnimations).toBe(false);
  });

  it('a revived monitor releases the overlay', () => {
    // What a reattach actually looks like: the adapter notices state flowing
    // again and reports a recovery. (It emits the state update first, which
    // `detached` reconciles without leaving — the release is this event.)
    const actor = detachedActor();
    actor.send({ type: 'TMUX_RECONNECTED' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('idle');
    expect(snapshot.context.connected).toBe(true);
  });

  it('a cold connect also releases it', () => {
    // The other way back: a transport that reconnects from scratch reports
    // TMUX_CONNECTED rather than a recovery.
    const actor = detachedActor();
    actor.send({ type: 'TMUX_CONNECTED' });

    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe('idle');
    expect(snapshot.context.connected).toBe(true);
  });

  it('stays detached while nothing has come back', () => {
    // The guard against "fixing" this by leaving `detached` on any event at
    // all: a retry notice means the channel is down, not that the user is back
    // in — it belongs in `reconnecting`, which shows a spinner.
    const actor = detachedActor();
    actor.send({ type: 'TMUX_RECONNECTING' });
    expect(actor.getSnapshot().matches('reconnecting')).toBe(true);
  });

  it('tells a detach from the session ending by what tmux said on its way out', () => {
    // A detach: the session goes on running, and the switcher keeps it.
    for (const reason of ['detached', 'detached (from session main)']) {
      const actor = createActor(appMachine).start();
      actor.send({ type: 'TMUX_DETACHED', reason });
      expect(actor.getSnapshot().context.sessionEnded).toBe(false);
    }
    // Its last pane exited, or it or the server was killed.
    for (const reason of [null, 'exited', 'server exited']) {
      const actor = createActor(appMachine).start();
      actor.send({ type: 'TMUX_DETACHED', reason });
      expect(actor.getSnapshot().context.sessionEnded).toBe(true);
      actor.send({ type: 'TMUX_CONNECTED' });
      expect(actor.getSnapshot().context.sessionEnded).toBe(false);
    }
  });

  it('a new session from the overlay is the switch alone, with no command for a connection that is gone', () => {
    const seen: string[] = [];
    const actor = createActor(appMachine, {
      inspect: (e) => {
        if (e.type === '@xstate.event')
          seen.push(`${(e.actorRef as { id?: string }).id}:${e.event.type}`);
      },
    }).start();
    actor.send({ type: 'TMUX_DETACHED', reason: null });
    actor.send({ type: 'NEW_SESSION', name: 'fresh' });
    expect(actor.getSnapshot().context.sessionName).toBe('fresh');
    // The transport is asked to switch, and the store is handed no op: on the
    // web the switch's attach is what creates the session.
    expect(seen).toContain('tmux:SWITCH_SESSION');
    expect(seen).not.toContain('tmuxStore:STORE_DISPATCH');
  });
});
