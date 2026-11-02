import { describe, it, expect } from 'vitest';
import { keyHint } from '../keyHint';
import { TmuxOp } from '../../commands';
import type { KeyBindings } from '../../wire';

/** tmux's own `&`, as `list-keys` prints it. */
const BINDINGS: KeyBindings = {
  prefix_key: 'C-a',
  prefix_bindings: [
    { key: '&', command: 'confirm-before -p "kill-window #W? (y/n)" kill-window', description: '' },
    { key: 'c', command: 'new-window -c "#{pane_current_path}"', description: '' },
  ],
  root_bindings: [],
  tables: {},
};

describe('keyHint', () => {
  it('names the binding whose command is the op, however the op spells its own', () => {
    // The close-tab op's command ends in the stash sweep; the binding is
    // still its hint.
    expect(keyHint(BINDINGS, TmuxOp.KillWindow({ windowId: null }))).toBe('ctrl+a &');
    expect(keyHint(BINDINGS, TmuxOp.NewWindow())).toBe('ctrl+a c');
  });

  it('is nothing for an op no key is bound to', () => {
    expect(keyHint(BINDINGS, TmuxOp.KillPane({ paneId: null }))).toBeUndefined();
    expect(keyHint(null, TmuxOp.NewWindow())).toBeUndefined();
  });
});
