/**
 * The phone's dock is sized to the view it is drawn in (SET_PHONE_DOCK_SIZE),
 * and the desktop's row count, worked out from the terminal's box, used to
 * write over it on the next update: the pane ran taller than its view and its
 * last rows, the prompt among them, were cut off once the keyboard came up.
 * And the dock holds the keyboard only while it is the view in front.
 */
import { describe, it, expect } from 'vitest';
import { fromCallback } from 'xstate';
import { sidebarsActions } from '../../actions/sidebars';
import { phoneActions } from '../../actions/phone';
import { keyboardActions } from '../../actions/keyboard';
import { keyboardGlobalEvents } from '../keyboard';
import { sidebarsGlobalEvents, sidebarsIdleEvents } from '../sidebars';
import { phoneGlobalEvents } from '../phone';
import type { TmuxOp } from '../../../../domain/commands';
import { pid, wid } from '../../../../test/wire';
import type { AppMachineContext } from '../../../types/context';
import { mountState } from './testHarness';

const state = {
  on: {
    ...sidebarsGlobalEvents,
    ...sidebarsIdleEvents,
    ...phoneGlobalEvents,
    ...keyboardGlobalEvents,
  },
};

const withDock = {
  activePaneId: pid('%1'),
  activeWindowId: wid('@1'),
  containerHeight: 600,
  windows: [
    { id: wid('@1'), index: 1, name: 'one', active: true, windowType: 'tab' },
    { id: wid('@9'), index: 9, name: 'dock', active: false, windowType: 'sidebar-right' },
  ],
  panes: [
    { tmuxId: pid('%1'), windowId: wid('@1'), active: true, x: 0, y: 0, width: 80, height: 24 },
    { tmuxId: pid('%9'), windowId: wid('@9'), active: true, x: 0, y: 0, width: 40, height: 30 },
  ],
} as unknown as Partial<AppMachineContext>;

function mount(context: Partial<AppMachineContext>) {
  const sent: TmuxOp[] = [];
  const tmux = fromCallback(({ receive }) => {
    receive((event) => {
      const e = event as unknown as { type: string; op?: TmuxOp };
      if (e.type === 'SEND_OP' && e.op) sent.push(e.op);
    });
  });
  const servers = fromCallback(() => () => {});
  const actor = mountState(
    state,
    { ...sidebarsActions, ...phoneActions, ...keyboardActions },
    {},
    context,
    {
      extraActors: { tmux, servers },
    },
  );
  return { actor, sent };
}

/** The rows written to the dock's window, in order. */
const rowsWritten = (sent: TmuxOp[]) =>
  sent.flatMap((op) =>
    op._tag === 'SetWindowTag' && op.tag === 'sidebar-rows' ? [Number(op.value)] : [],
  );

describe('the phone’s dock rows', () => {
  it('are the view’s, and an update never writes the terminal box’s count over them', () => {
    const { actor, sent } = mount({ ...withDock, phoneLayout: true });
    actor.send({ type: 'SET_PHONE_DOCK_SIZE', cols: 40, rows: 8 });
    actor.send({ type: 'SYNC_DOCK_SIZE' });
    actor.send({ type: 'SYNC_DOCK_SIZE' });
    expect(rowsWritten(sent)).toEqual([8]);
  });

  it('follow the terminal box on a desktop', () => {
    const { actor, sent } = mount({ ...withDock, phoneLayout: false });
    actor.send({ type: 'SYNC_DOCK_SIZE' });
    expect(rowsWritten(sent)).toHaveLength(1);
    expect(rowsWritten(sent)[0]).toBeGreaterThan(24);
  });
});

describe('the bottom view', () => {
  it('gives the dock the keyboard in front and takes it back for the menu and the tree', () => {
    const { actor } = mount({ ...withDock, phoneLayout: true });
    const ctx = () => actor.getSnapshot().context as AppMachineContext;
    actor.send({ type: 'SET_PHONE_BOTTOM_VIEW', view: 'dock' });
    expect(ctx().phoneBottomView).toBe('dock');
    expect(ctx().keyboardOwner).toMatchObject({ kind: 'right', paneId: pid('%9') });
    actor.send({ type: 'SET_PHONE_BOTTOM_VIEW', view: 'menu' });
    expect(ctx().phoneBottomView).toBe('menu');
    expect(ctx().keyboardOwner.kind).toBe('panes');
    actor.send({ type: 'SET_PHONE_BOTTOM_VIEW', view: 'dock' });
    actor.send({ type: 'SET_PHONE_BOTTOM_VIEW', view: 'tree' });
    expect(ctx().keyboardOwner.kind).toBe('panes');
  });
});
