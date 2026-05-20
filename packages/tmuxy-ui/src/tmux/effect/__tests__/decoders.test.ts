import { describe, it, expect } from 'vitest';
import { Effect, Exit } from 'effect';
import {
  decodeStateUpdate,
  decodeServerState,
  decodeServerDelta,
  decodeKeyBindings,
} from '../decoders';

/** Build a minimally-valid ServerPane payload for fixture reuse. */
function fixturePane(tmuxId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 0,
    tmux_id: tmuxId,
    window_id: '@0',
    content: [],
    cursor_x: 0,
    cursor_y: 0,
    width: 80,
    height: 24,
    x: 0,
    y: 0,
    active: true,
    command: 'bash',
    title: '',
    border_title: '',
    in_mode: false,
    copy_cursor_x: 0,
    copy_cursor_y: 0,
    ...overrides,
  };
}

function fixtureWindow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    index: 0,
    name: 'main',
    active: true,
    window_type: 'tab',
    ...overrides,
  };
}

function fixtureServerState() {
  return {
    session_name: 'tmuxy',
    active_window_id: '@0',
    active_pane_id: '%0',
    panes: [fixturePane('%0')],
    windows: [fixtureWindow('@0')],
    total_width: 80,
    total_height: 24,
    status_line: '',
  };
}

describe('decodeStateUpdate', () => {
  it('accepts a well-formed full update', async () => {
    const payload = { type: 'full', state: fixtureServerState() };
    const exit = await Effect.runPromiseExit(decodeStateUpdate(payload));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.type).toBe('full');
      if (exit.value.type === 'full') {
        expect(exit.value.state.session_name).toBe('tmuxy');
      }
    }
  });

  it('accepts a well-formed delta update', async () => {
    const payload = {
      type: 'delta',
      delta: { seq: 1, active_pane_id: '%5' },
    };
    const exit = await Effect.runPromiseExit(decodeStateUpdate(payload));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('fails with ProtocolError when type discriminator is unknown', async () => {
    const payload = { type: 'bogus', state: fixtureServerState() };
    const exit = await Effect.runPromiseExit(decodeStateUpdate(payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/ProtocolError/);
      expect(json).toMatch(/StateUpdate/);
    }
  });

  it('fails with ProtocolError when ServerState is missing required fields', async () => {
    const payload = { type: 'full', state: { session_name: 'tmuxy' } };
    const exit = await Effect.runPromiseExit(decodeStateUpdate(payload));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it('preserves the raw payload in ProtocolError for debugging', async () => {
    const payload = { not: 'a state update at all' };
    const exit = await Effect.runPromiseExit(decodeStateUpdate(payload));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      // Walk Cause to find the failure
      const json = JSON.stringify(exit.cause);
      expect(json).toMatch(/not.*a state update at all/);
    }
  });
});

describe('decodeServerState', () => {
  it('accepts a well-formed state', async () => {
    const exit = await Effect.runPromiseExit(decodeServerState(fixtureServerState()));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('rejects a state with non-string session_name', async () => {
    const bad = { ...fixtureServerState(), session_name: 42 };
    const exit = await Effect.runPromiseExit(decodeServerState(bad));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it('accepts panes with optional fields omitted', async () => {
    // alternate_on / mouse_any_flag / paused / etc are all optional
    const exit = await Effect.runPromiseExit(decodeServerState(fixtureServerState()));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('accepts active_pane_id as null', async () => {
    const state = { ...fixtureServerState(), active_pane_id: null };
    const exit = await Effect.runPromiseExit(decodeServerState(state));
    expect(Exit.isSuccess(exit)).toBe(true);
  });
});

describe('decodeServerDelta', () => {
  it('accepts a minimal delta (just seq)', async () => {
    const exit = await Effect.runPromiseExit(decodeServerDelta({ seq: 42 }));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('accepts pane removal via null value', async () => {
    const exit = await Effect.runPromiseExit(
      decodeServerDelta({
        seq: 7,
        panes: { '%5': null, '%6': { cursor_x: 3 } },
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('rejects delta missing the seq field', async () => {
    const exit = await Effect.runPromiseExit(decodeServerDelta({ panes: {} }));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('decodeKeyBindings', () => {
  it('accepts a well-formed payload', async () => {
    const exit = await Effect.runPromiseExit(
      decodeKeyBindings({
        prefix_key: 'C-b',
        prefix_bindings: [{ key: 'c', command: 'new-window', description: 'New window' }],
        root_bindings: [],
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('accepts optional repeat flag on bindings', async () => {
    const exit = await Effect.runPromiseExit(
      decodeKeyBindings({
        prefix_key: 'C-b',
        prefix_bindings: [
          { key: 'H', command: 'resize-pane -L', description: 'Shrink left', repeat: true },
        ],
        root_bindings: [],
      }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it('rejects payload missing prefix_key', async () => {
    const exit = await Effect.runPromiseExit(
      decodeKeyBindings({ prefix_bindings: [], root_bindings: [] }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
