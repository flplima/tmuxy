import { describe, it, expect } from 'vitest';
import { DemoTmux } from '../DemoTmux';
import { Schema } from 'effect';
import { ServerState } from '../../../../../domain/wire';

describe('DemoTmux', () => {
  it('emits protocol-valid ServerState (decodes through the wire schema)', () => {
    // Decode through the SAME Effect schema the production adapter uses for
    // get_initial_state: the VALUES against the wire contract, which is what
    // every story built on the demo engine relies on.
    const tmux = new DemoTmux();
    tmux.init(80, 24);
    tmux.splitPane('horizontal');
    tmux.createFloat({ width: 30, height: 8 });
    const state = tmux.getState();
    expect(() => Schema.decodeUnknownSync(ServerState)(state)).not.toThrow();
  });
});
