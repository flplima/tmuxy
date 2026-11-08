/**
 * A prefix binding on a key with a modifier (`prefix M-y`, `prefix C-o`) is
 * a binding of its own: tmux's `rotate-window` is `prefix C-o`, and a
 * plugin's `[[keys]]` may bind `M-y`.
 */

import { describe, expect, it } from 'vitest';
import { pid } from '../../../test/wire';
import { lastSendCommand, pressKey, spawnKeyboardActor } from './keyboardHarness';

describe('keyboardActor — a prefix binding with a modifier', () => {
  it('runs the binding for the key with Alt or Ctrl, and the bare one without', () => {
    const { events, set } = spawnKeyboardActor(pid('%1'));
    set({
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
