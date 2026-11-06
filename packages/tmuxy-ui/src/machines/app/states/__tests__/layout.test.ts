import { describe, it, expect, vi } from 'vitest';
import { pid } from '../../../../test/wire';
import { placeholderPaneId } from '../../../../domain/ids';
import { TmuxOp } from '../../../../domain/commands';
import { layoutState } from '../layout';
import { layoutActions } from '../../actions/layout';
import { act } from '../../actionTypes';
import { mountState, sendAndGetContext } from './testHarness';
import type { ResizeState } from '../../../types/domain';

describe('layout state', () => {
  it('RESIZE_STATE_UPDATE writes resize and resizeActive flag', () => {
    const actor = mountState(layoutState, layoutActions, {
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

  it('the 2s RESIZE_COMPLETED fallback clears a stale preview when no server update arrives', () => {
    vi.useFakeTimers();
    try {
      const actor = mountState(layoutState, layoutActions, {
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
      const actor = mountState(layoutState, layoutActions, {
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
      const raised: TmuxOp[] = [];
      const state = { on: { ...layoutState.on, DISPATCH_OP: { actions: 'recordOp' } } };
      const actor = mountState(
        state,
        {
          ...layoutActions,
          recordOp: act(({ event }) => {
            if (event.type === 'DISPATCH_OP') raised.push(event.op);
          }),
        },
        context,
      );
      actor.send({ type: 'CLOSE_PANE', paneId: null });
      return raised;
    };

    it('closes the float that holds the keyboard, through the group-aware close', () => {
      const raised = close({
        activePaneId: pid('%3'),
        keyboardOwner: { kind: 'float', paneId: pid('%9') },
        floatPanes: { [pid('%9')]: { paneId: pid('%9') } },
      });
      expect(raised).toEqual([TmuxOp.GroupClose({ paneId: pid('%9') })]);
    });

    it('else the active pane', () => {
      expect(close({ activePaneId: pid('%3') })).toEqual([TmuxOp.KillPane({ paneId: pid('%3') })]);
    });

    it('else, while the active pane is a placeholder, tmux’s own active pane', () => {
      expect(close({ activePaneId: placeholderPaneId('5') })).toEqual([
        TmuxOp.KillPane({ paneId: null }),
      ]);
    });
  });
});
