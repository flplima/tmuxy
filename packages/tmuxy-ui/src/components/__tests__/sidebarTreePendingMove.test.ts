/**
 * A pane dropped on another tab is listed there at once; the grid cannot
 * predict a `join-pane`, so a refused one never reaches the tree as a
 * rollback. The hold used to be unbounded: the pane stayed listed under the
 * wrong tab until it moved or died.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePendingMove, PENDING_MOVE_TIMEOUT_MS } from '../sidebarTreePendingMove';
import { pid, wid } from '../../test/wire';

const panes = [
  { tmuxId: pid('%1'), windowId: wid('@1') },
  { tmuxId: pid('%2'), windowId: wid('@2') },
];

describe('usePendingMove', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives a move tmux never carried out back after the hold runs out', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePendingMove(panes));
    act(() => result.current.startMove(pid('%1'), wid('@2')));
    expect(result.current.pendingMove).toEqual({ paneId: pid('%1'), windowId: wid('@2') });

    act(() => vi.advanceTimersByTime(PENDING_MOVE_TIMEOUT_MS - 1));
    expect(result.current.pendingMove).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.pendingMove).toBeNull();
  });

  it('clears the move as soon as the model agrees', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ panes }) => usePendingMove(panes), {
      initialProps: { panes },
    });
    act(() => result.current.startMove(pid('%1'), wid('@2')));
    rerender({
      panes: panes.map((p) => (p.tmuxId === pid('%1') ? { ...p, windowId: wid('@2') } : p)),
    });
    expect(result.current.pendingMove).toBeNull();
  });

  it('a later drop is held for its own full window, not the first drop’s remainder', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePendingMove(panes));
    act(() => result.current.startMove(pid('%1'), wid('@2')));
    act(() => vi.advanceTimersByTime(PENDING_MOVE_TIMEOUT_MS - 100));
    act(() => result.current.startMove(pid('%2'), wid('@1')));
    act(() => vi.advanceTimersByTime(200));
    expect(result.current.pendingMove).toEqual({ paneId: pid('%2'), windowId: wid('@1') });
  });
});
