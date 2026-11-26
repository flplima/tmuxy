import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { modelPane, modelUpdate, modelWindow } from '../../../../test/model';
import { recorder } from '../../../../test/app';
import { viewportGlobalEvents } from '../viewport';
import { viewportActions } from '../../actions/viewport';
import { layoutModelUpdateActions } from '../../actions/layout/modelUpdate';
import { mountState, sendAndGetContext } from './testHarness';
import type { AppMachineContext } from '../../../types/context';

/**
 * A client tells programs its cell size (`@tmuxy-cell-px`) through a
 * `TmuxOp`: when it has a state and the option is unset or differs, and when
 * its own cell changes; never because the option changed.
 */

const on = {
  ...viewportGlobalEvents,
  TMUX_MODEL_UPDATE: { actions: ['layout_modelUpdate', 'viewport_announceCellSize'] },
};

/** A connected client drawing `width` by `height`, and the sizes it announced. */
function client(width: number, height: number, overrides: Partial<AppMachineContext> = {}) {
  const tmux = recorder();
  const actor = mountState(
    { on },
    { ...viewportActions, ...layoutModelUpdateActions },
    { connected: true, charWidth: width, charHeight: height, ...overrides },
    { extraActors: { tmux: tmux.logic } },
  );
  const announced = () =>
    tmux.ops().flatMap((op) => (op._tag === 'AnnounceCellSize' ? [op.size] : []));
  /** tmux's state reaches the client, with the option as it stands. */
  const update = (cellPx: string) =>
    sendAndGetContext(
      actor,
      modelUpdate(
        [modelPane(pid('%1'), wid('@1'))],
        [modelWindow(wid('@1'), 0)],
        {
          paneId: pid('%1'),
          windowId: wid('@1'),
        },
        { cellPx },
      ),
    );
  return { actor, announced, update };
}

describe('announcing the cell size', () => {
  it('two clients with different cells write once each, and never in answer to the other', () => {
    // The option both clients share, and what each has written to it so far.
    let option = '';
    const a = client(9, 24);
    const b = client(10, 26);
    const written = new Map([
      [a, 0],
      [b, 0],
    ]);
    /** tmux's state reaches `c`; whatever it writes is the option from then on. */
    const reach = (c: typeof a) => {
      c.update(option);
      const sizes = c.announced();
      if (sizes.length > (written.get(c) ?? 0)) {
        written.set(c, sizes.length);
        option = sizes[sizes.length - 1];
      }
    };
    const rounds = () => {
      for (let round = 0; round < 4; round++) {
        reach(a);
        reach(b);
      }
    };

    reach(a);
    expect(option).toBe('9x24');
    rounds();
    expect(a.announced()).toEqual(['9x24']);
    expect(b.announced()).toEqual(['10x26']);
    expect(option).toBe('10x26');

    // A's font changes: A measured last, and B lets it stand.
    sendAndGetContext(a.actor, {
      type: 'SET_CHAR_SIZE',
      charWidth: 8.5,
      charHeight: 24,
      cellGap: 0,
    });
    expect(a.announced()).toEqual(['9x24', '8.5x24']);
    option = '8.5x24';
    written.set(a, 2);
    rounds();
    expect(b.announced()).toEqual(['10x26']);
    expect(option).toBe('8.5x24');
  });

  it('a client that finds its own cell announced, or has no state yet, writes nothing', () => {
    const same = client(9, 24);
    same.update('9x24');
    same.update('10x26');
    expect(same.announced()).toEqual([]);

    const offline = client(9, 24, { connected: false });
    offline.update('');
    sendAndGetContext(offline.actor, {
      type: 'SET_CHAR_SIZE',
      charWidth: 10,
      charHeight: 24,
      cellGap: 0,
    });
    expect(offline.announced()).toEqual([]);
  });
});
