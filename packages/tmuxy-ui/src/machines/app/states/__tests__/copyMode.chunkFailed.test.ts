import { describe, it, expect } from 'vitest';
import { fromCallback } from 'xstate';
import { pid } from '../../../../test/wire';
import { copyModeState } from '../copyMode';
import { copyModeActions } from '../../actions/copyMode';
import { mountState, sendAndGetContext } from './testHarness';
import type { CopyModeState } from '../../../../domain/copyMode';
import type { CellLine } from '../../../../domain/wireCells';
import type { PaneId } from '../../../../domain/ids';

const copyModeGuards = {};

function makeLine(text: string): CellLine {
  return text.split('').map((c) => ({ c }));
}

/** A copy-mode view on the last two rows of a 50-row history. */
function makeCopyState(extra: Partial<CopyModeState> = {}): CopyModeState {
  const lines = new Map<number, CellLine>();
  lines.set(48, makeLine('hello world'));
  lines.set(49, makeLine('second line'));
  return {
    mode: 'copy',
    lines,
    totalLines: 50,
    historySize: 48,
    loadedRanges: [[48, 49]],
    loading: false,
    width: 80,
    height: 2,
    cursorRow: 48,
    cursorCol: 0,
    selectionMode: null,
    selectionAnchor: null,
    scrollTop: 48,
    ...extra,
  };
}

describe('copyMode state — a chunk that fails to load', () => {
  it('a chunk that fails to load stops the wait, so the next scroll asks again', () => {
    // One failed get_scrollback_cells must not leave the record loading for
    // the rest of copy mode: fetchNeededChunk bails while `loading` is set.
    const fetches: string[] = [];
    const actor = mountState(
      copyModeState,
      copyModeActions,
      copyModeGuards,
      {
        copyModeStates: {
          [pid('%1')]: makeCopyState({ loading: true }),
        },
      },
      {
        extraActors: {
          tmux: fromCallback<{ type: string; paneId?: PaneId }>(({ receive }) => {
            receive((e) => {
              if (e.type === 'FETCH_SCROLLBACK_CELLS') fetches.push(e.paneId!);
            });
            return () => {};
          }),
        },
      },
    );

    let ctx = sendAndGetContext(actor, {
      type: 'COPY_MODE_SCROLL',
      paneId: pid('%1'),
      scrollTop: 20,
    });
    expect(ctx.copyModeStates[pid('%1')].loading).toBe(true);
    expect(fetches).toEqual([]);

    ctx = sendAndGetContext(actor, { type: 'COPY_MODE_CHUNK_FAILED', paneId: pid('%1') });
    expect(ctx.copyModeStates[pid('%1')].loading).toBe(false);

    ctx = sendAndGetContext(actor, { type: 'COPY_MODE_SCROLL', paneId: pid('%1'), scrollTop: 10 });
    expect(fetches).toEqual([pid('%1')]);
    expect(ctx.copyModeStates[pid('%1')].loading).toBe(true);
  });

  it('a failed chunk for a pane no longer in copy mode changes nothing', () => {
    const actor = mountState(copyModeState, copyModeActions, copyModeGuards, {
      copyModeStates: {},
    });
    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_CHUNK_FAILED', paneId: pid('%1') });
    expect(ctx.copyModeStates).toEqual({});
  });
});
