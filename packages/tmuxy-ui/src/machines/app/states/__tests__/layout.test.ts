import { describe, it, expect, vi } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { placeholderPaneId } from '../../../../domain/ids';
import { fromCallback } from 'xstate';
import { TmuxOp } from '../../../../domain/commands';
import { layoutState } from '../layout';
import { layoutActions } from '../../actions/layout';
const layoutGuards = {};
import { mountState, sendAndGetContext } from './testHarness';
import type { ResizeState, DragState } from '../../../types/domain';

describe('layout state', () => {
  it('SELECT_TAB hands the switch to the store, which predicts it', () => {
    const sent: unknown[] = [];
    const tmuxStore = fromCallback(({ receive }) => {
      receive((event) => void sent.push(event));
    });
    const actor = mountState(
      layoutState,
      layoutActions,
      {},
      { activeWindowId: wid('@0') },
      {
        extraActors: { tmuxStore },
      },
    );
    const ctx = sendAndGetContext(actor, { type: 'SELECT_TAB', windowId: wid('@1') });
    expect(sent).toEqual([{ type: 'DISPATCH_OP', op: TmuxOp.SelectWindow({ target: wid('@1') }) }]);
    // The machine assigns nothing itself: the store's model update does.
    expect(ctx.activeWindowId).toBe(wid('@0'));
  });

  it('SELECT_TAB is a no-op when already on the target window', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      activeWindowId: wid('@5'),
      windows: [],
    });
    const ctx = sendAndGetContext(actor, {
      type: 'SELECT_TAB',
      windowId: wid('@5'),
    });
    expect(ctx.activeWindowId).toBe(wid('@5'));
  });

  it('RESIZE_STATE_UPDATE writes resize and resizeActive flag', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      resize: null,
      resizeActive: false,
    });
    const resize = { paneId: pid('%1'), handle: 'e' } as unknown as ResizeState;
    let ctx = sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize });
    expect(ctx.resize).toEqual(resize);
    expect(ctx.resizeActive).toBe(true);
    ctx = sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize: null });
    expect(ctx.resizeActive).toBe(false);
  });

  it('DRAG_STATE_UPDATE assigns the drag field directly', () => {
    const actor = mountState(layoutState, layoutActions, layoutGuards, {
      drag: null,
    });
    // A real payload: null → null would pass with the handler deleted.
    const drag = { paneId: pid('%2'), currentX: 10, currentY: 20 } as unknown as DragState;
    let ctx = sendAndGetContext(actor, { type: 'DRAG_STATE_UPDATE', drag });
    expect(ctx.drag).toEqual(drag);
    // ...and null clears it again.
    ctx = sendAndGetContext(actor, { type: 'DRAG_STATE_UPDATE', drag: null });
    expect(ctx.drag).toBeNull();
  });

  it('the 2s RESIZE_COMPLETED fallback clears a stale preview when no server update arrives', () => {
    vi.useFakeTimers();
    try {
      const actor = mountState(layoutState, layoutActions, layoutGuards, {
        resize: null,
        resizeActive: false,
      });
      const resize = { paneId: pid('%1'), handle: 'e' } as unknown as ResizeState;
      sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize });
      actor.send({ type: 'RESIZE_COMPLETED' });
      // No new resize and no TMUX_STATE_UPDATE: the fallback nulls the preview.
      vi.advanceTimersByTime(2000);
      expect(actor.getSnapshot().context.resize).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the 2s RESIZE_COMPLETED fallback does not clobber a newer resize started within the window', () => {
    vi.useFakeTimers();
    try {
      const actor = mountState(layoutState, layoutActions, layoutGuards, {
        resize: null,
        resizeActive: false,
      });
      const resizeA = { paneId: pid('%1'), handle: 'e' } as unknown as ResizeState;
      sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize: resizeA });
      // Resize A finishes, scheduling the 2s fallback bound to A.
      actor.send({ type: 'RESIZE_COMPLETED' });
      // The user starts a fresh resize B before the fallback fires.
      const resizeB = { paneId: pid('%2'), handle: 's' } as unknown as ResizeState;
      sendAndGetContext(actor, { type: 'RESIZE_STATE_UPDATE', resize: resizeB });
      // A's stale timer fires — B's live preview must survive.
      vi.advanceTimersByTime(2000);
      expect(actor.getSnapshot().context.resize).toEqual(resizeB);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('CLOSE_PANE with no pane named (the app menu’s Close Pane)', () => {
    const close = (context: Record<string, unknown>) => {
      const toStore: unknown[] = [];
      const raised: TmuxOp[] = [];
      const tmuxStore = fromCallback(({ receive }) => {
        receive((event) => void toStore.push(event));
      });
      const state = {
        on: {
          ...layoutState.on,
          DISPATCH_OP: { actions: 'recordOp' },
        },
      };
      const actor = mountState(
        state,
        {
          ...layoutActions,
          recordOp: ({ event }: { event: { op: TmuxOp } }) => void raised.push(event.op),
        },
        {},
        context,
        { extraActors: { tmuxStore } },
      );
      actor.send({ type: 'CLOSE_PANE', paneId: null });
      return { toStore, raised };
    };

    it('closes the float that holds the keyboard, through the group-aware close', () => {
      const { raised } = close({
        activePaneId: pid('%3'),
        keyboardOwner: { kind: 'float', paneId: pid('%9') },
        floatPanes: { [pid('%9')]: { paneId: pid('%9') } },
      });
      expect(raised).toEqual([TmuxOp.GroupClose({ paneId: pid('%9') })]);
    });

    it('else the active pane', () => {
      const { toStore } = close({ activePaneId: pid('%3') });
      expect(toStore).toEqual([
        { type: 'DISPATCH_OP', op: TmuxOp.KillPane({ paneId: pid('%3') }) },
      ]);
    });

    it('else, while the active pane is a placeholder, tmux’s own active pane', () => {
      const { toStore } = close({ activePaneId: placeholderPaneId('5') });
      expect(toStore).toEqual([{ type: 'DISPATCH_OP', op: TmuxOp.KillPane({ paneId: null }) }]);
    });
  });
});
