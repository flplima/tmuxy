import { describe, it, expect, vi } from 'vitest';
import { commandHint, executeMenuCommand, MENU_COMMANDS } from '../actions';
import type { KeyBindings } from '../../../../domain/wire';

describe('executeMenuCommand', () => {
  // Rename Tab renames in the strip, where the name is — not in tmux's prompt
  // at the bottom of the window; Stacked Panes flips the active tab's option.
  it('routes Rename Tab and Stacked Panes to the machine, not to a tmux command', () => {
    const send = vi.fn();
    executeMenuCommand(send, 'tab-rename');
    expect(send).toHaveBeenCalledWith({ type: 'RENAME_ACTIVE_TAB' });
    executeMenuCommand(send, 'tab-stack-toggle');
    expect(send).toHaveBeenCalledWith({ type: 'TOGGLE_STACKED_PANES' });
  });
});

describe('commandHint', () => {
  const BINDINGS: KeyBindings = {
    prefix_key: 'C-a',
    repeat_time_ms: 300,
    prefix_bindings: [
      { key: 'c', command: 'new-window -c "#{pane_current_path}"', description: '' },
      { key: 'd', command: 'detach-client', description: '' },
    ],
    root_bindings: [],
    tables: {},
  };

  it('names the binding of what the command does, or the client key when tmux has none', () => {
    expect(commandHint(BINDINGS, 'tab-new')).toBe('ctrl+a c');
    expect(commandHint(BINDINGS, 'session-detach')).toBe('ctrl+a d');
    expect(commandHint(BINDINGS, 'tab-overview')).toBe('ctrl+0');
    expect(commandHint(BINDINGS, 'session-new')).toBeUndefined();
  });

  it('every command runs something', () => {
    for (const id of Object.keys(MENU_COMMANDS) as Array<keyof typeof MENU_COMMANDS>) {
      if (id === 'restart-app') continue;
      const send = vi.fn();
      executeMenuCommand(send, id);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
