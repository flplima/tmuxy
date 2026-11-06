import { describe, it, expect, vi } from 'vitest';
import { placeholderPaneId } from '../../../../domain/ids';
import { pid } from '../../../../test/wire';
import { activeCloseTarget, commandHint, executeMenuCommand, MENU_COMMANDS } from '../actions';
import { TmuxOp } from '../../../../domain/commands';
import type { AppMachineEvent } from '../../../../machines/types/events';
import type { KeyBindings } from '../../../../domain/wire';

describe('activeCloseTarget', () => {
  it('prefers the focused float pane', () => {
    expect(activeCloseTarget(pid('%3'), pid('%9'))).toBe(pid('%9'));
  });

  it('falls back to the real active pane when no float is focused', () => {
    expect(activeCloseTarget(pid('%3'), null)).toBe(pid('%3'));
  });

  it('ignores an optimistic placeholder active pane', () => {
    expect(activeCloseTarget(placeholderPaneId('5'), null)).toBeUndefined();
  });

  it('returns undefined when there is no active pane', () => {
    expect(activeCloseTarget(null, null)).toBeUndefined();
  });
});

describe('executeMenuCommand pane-close routing', () => {
  it('routes to group-aware CLOSE_PANE when a target pane is known', () => {
    const sent: AppMachineEvent[] = [];
    const send = (e: AppMachineEvent) => sent.push(e);
    executeMenuCommand(send, 'pane-close', pid('%7'));
    expect(sent).toEqual([{ type: 'CLOSE_PANE', paneId: pid('%7') }]);
  });

  it('falls back to raw kill-pane when no target pane is known', () => {
    const send = vi.fn();
    executeMenuCommand(send, 'pane-close');
    expect(send).toHaveBeenCalledWith({
      type: 'DISPATCH_OP',
      op: TmuxOp.KillPane({ paneId: null }),
    });
  });

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
      executeMenuCommand(send, id, pid('%1'));
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
