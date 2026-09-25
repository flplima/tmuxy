import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLatchedContent } from '../useLatchedContent';
import type { PaneContent } from '../../tmux/types';

const grid = (text: string): PaneContent => [[...text].map((c) => ({ c }))];

/**
 * A pane-group switch does `swap-pane`, which leaves the pane's content an
 * EMPTY ARRAY for a tick while the capture refresh is in flight. Drawing that
 * frame is the flicker the bug was about.
 */
describe('useLatchedContent', () => {
  it('holds the last real grid while the pane has no rows at all', () => {
    const first = grid('before the swap');
    const { result, rerender } = renderHook(({ content }) => useLatchedContent(content), {
      initialProps: { content: first as PaneContent | undefined },
    });
    expect(result.current).toBe(first);

    // The gap: no rows. The previous grid keeps being drawn.
    rerender({ content: [] });
    expect(result.current).toBe(first);

    rerender({ content: undefined });
    expect(result.current).toBe(first);

    // The new grid arrives and takes over.
    const second = grid('after the swap');
    rerender({ content: second });
    expect(result.current).toBe(second);
  });

  it('does not hide a screen that was legitimately cleared', () => {
    // A cleared screen still HAS its rows — they are full of spaces. Only "no
    // rows" means "not captured yet", which is why the latch cannot swallow a
    // real clear.
    const cleared: PaneContent = [[{ c: ' ' }], [{ c: ' ' }]];
    const { result, rerender } = renderHook(({ content }) => useLatchedContent(content), {
      initialProps: { content: grid('output') as PaneContent | undefined },
    });
    rerender({ content: cleared });
    expect(result.current).toBe(cleared);
  });

  it('starts with nothing rather than inventing a grid', () => {
    const { result } = renderHook(() => useLatchedContent(undefined));
    expect(result.current).toEqual([]);
  });
});
