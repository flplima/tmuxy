import { describe, it, expect } from 'vitest';
import { fromCallback } from 'xstate';
import { dispatchActions } from '../../dispatch';
import { TmuxOp } from '../../../../domain/commands';
import { placeholderPaneId, placeholderWindowId } from '../../../../domain/ids';
import type { AppMachineContext } from '../../../types';
import { mountState } from './testHarness';

const dispatchState = {
  on: {
    DISPATCH_OP: { actions: 'dispatch_op' },
    SEND_TMUX_COMMAND: { actions: 'dispatch_command' },
  },
};

/** The dispatch slice over a recording store; returns what reached the store. */
function mountDispatch(context: Partial<AppMachineContext>) {
  const sent: Array<{ op: TmuxOp; command?: string }> = [];
  const tmuxStore = fromCallback(({ receive }) => {
    receive((event) => {
      const { op, command } = event as unknown as { op: TmuxOp; command?: string };
      sent.push({ op, command });
    });
  });
  const actor = mountState(dispatchState, dispatchActions, {}, context, {
    extraActors: { tmuxStore },
  });
  return { actor, sent };
}

describe('dispatch while a split or new tab is still predicted', () => {
  // Right after a predicted split or new tab, the client's active pane and
  // window are placeholders tmux has never heard of.
  const predicted = {
    activePaneId: placeholderPaneId('op1'),
    activeWindowId: placeholderWindowId('op1'),
  };

  it('leaves the target to tmux rather than naming a placeholder', () => {
    const { actor, sent } = mountDispatch(predicted);
    actor.send({ type: 'DISPATCH_OP', op: TmuxOp.CyclePane({ windowId: null }) });
    actor.send({ type: 'DISPATCH_OP', op: TmuxOp.GroupAdd({ pane: null }) });
    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'select-pane -t :.+' });
    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'run-shell "x #{pane_id}"' });

    expect(sent.map((s) => s.op)).toEqual([
      TmuxOp.CyclePane({ windowId: null }),
      TmuxOp.GroupAdd({ pane: null }),
      expect.anything(),
      expect.anything(),
    ]);
    expect(sent[2].command).toBe('select-pane -t :.+');
    expect(sent[3].command).toBe('run-shell "x #{pane_id}"');
  });

  it('once tmux has confirmed them, names the client’s own active window and pane', () => {
    const { actor, sent } = mountDispatch({ activePaneId: '%3', activeWindowId: '@2' } as never);
    actor.send({ type: 'DISPATCH_OP', op: TmuxOp.CyclePane({ windowId: null }) });
    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'select-pane -t :.+' });
    actor.send({ type: 'SEND_TMUX_COMMAND', command: 'run-shell "x #{pane_id}"' });

    expect(sent[0].op).toEqual(TmuxOp.CyclePane({ windowId: '@2' as never }));
    expect(sent[1].command).toBe('select-pane -t @2.+');
    expect(sent[2].command).toBe('run-shell "x %3"');
  });
});
