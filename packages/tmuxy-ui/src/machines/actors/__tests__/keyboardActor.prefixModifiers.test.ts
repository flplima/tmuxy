/**
 * A prefix binding on a key with a modifier (`prefix M-y`, `prefix C-o`) is
 * a binding of its own: tmux's `rotate-window` is `prefix C-o`, and a
 * plugin's `[[keys]]` may bind `M-y`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AnyActorRef } from 'xstate';
import { pid } from '../../../test/wire';
import { lastSendCommand, pressKey, spawnKeyboardActor } from './keyboardHarness';

const running: AnyActorRef[] = [];
afterEach(() => {
  while (running.length) running.pop()?.stop();
});

describe('keyboardActor — a prefix binding with a modifier', () => {
  /**
   * `prefix M-y` and `prefix C-o` are bindings of their own (tmux's
   * `rotate-window` is `prefix C-o`, a plugin's `[[keys]]` may be `M-y`): the
   * key they were bound to runs, not the bare letter's.
   */
  it('runs the binding for the key with Alt or Ctrl, and the bare one without', () => {
    const { actor, child, events } = spawnKeyboardActor(pid('%1'));
    running.push(actor);
    child.send({
      type: 'UPDATE_KEYBINDINGS',
      keybindings: {
        prefix_key: 'C-a',
        tables: {},
        prefix_bindings: [
          { key: 'o', command: 'select-pane -t :.+', repeat: false },
          { key: 'C-o', command: 'rotate-window', repeat: false },
          { key: 'M-y', command: 'display-message plugin', repeat: false },
        ],
        root_bindings: [],
      },
    });
    const ran = () => lastSendCommand(events)?.split(' \\; ').pop();

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'y', altKey: true });
    expect(ran()).toBe('display-message plugin');

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'o', ctrlKey: true });
    expect(ran()).toBe('rotate-window');

    pressKey({ key: 'a', ctrlKey: true });
    pressKey({ key: 'o' });
    expect(ran()).toBe('select-pane -t :.+');
  });
});
