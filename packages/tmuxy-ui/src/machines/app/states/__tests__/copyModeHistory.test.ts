import { describe, it, expect } from 'vitest';
import { pid, wid } from '../../../../test/wire';
import { copyModeState } from '../copyMode';
import { copyModeActions } from '../../actions/copyMode';
import { FIRST_HISTORY_ROWS, HISTORY_CHUNK_ROWS } from '../../actions/copyMode/scrollback';
import { mountState, sendAndGetContext } from './testHarness';
import { cellLine, modelPane } from '../../../../test/model';
import { recorder } from '../../../../test/app';
describe('copyMode state — a long history', () => {
  /**
   * Over 10,000 rows, the view asks first for the newest few hundred, which
   * a wheel scroll shows at once, then for the rest, older and older; it
   * used to ask for all of it at once, and showed placeholders until all of
   * it arrived.
   */
  it('is fetched newest first: the rows nearest the screen, then older chunks to the first', () => {
    const history = 10000;
    const pane = modelPane(pid('%1'), wid('@0'), {
      content: [cellLine('line a'), cellLine('line b')],
      height: 2,
      active: true,
      historySize: history,
    });
    const tmux = recorder();
    const fetched = () =>
      tmux.received
        .filter((e) => e.type === 'FETCH_SCROLLBACK_CELLS')
        .map((e) => [e.start as number, e.end as number]);
    const actor = mountState(
      copyModeState,
      copyModeActions,
      { panes: [pane] },
      { extraActors: { tmux: tmux.logic } },
    );
    sendAndGetContext(actor, { type: 'ENTER_SCROLL_MODE', paneId: pid('%1') });
    expect(fetched()).toEqual([[-FIRST_HISTORY_ROWS, 1]]);

    // Each answer brings the chunk it asked for; the next is the one above.
    const answer = (start: number, end: number) =>
      sendAndGetContext(actor, {
        type: 'COPY_MODE_CHUNK_LOADED',
        paneId: pid('%1'),
        cells: Array.from({ length: end - start + 1 }, (_, i) => cellLine(`row ${start + i}`)),
        start,
        end,
        historySize: history,
        width: 80,
      });
    let ctx = answer(-FIRST_HISTORY_ROWS, 1);
    for (let guard = 0; guard < 10 && ctx.copyModeStates[pid('%1')].loading; guard++) {
      const [start, end] = fetched()[fetched().length - 1];
      ctx = answer(start, end);
    }
    const chunks = fetched().slice(1);
    expect(chunks[0]).toEqual([-FIRST_HISTORY_ROWS - HISTORY_CHUNK_ROWS, -FIRST_HISTORY_ROWS - 1]);
    expect(chunks[chunks.length - 1][0]).toBe(-history);
    expect(chunks.every(([start, end]) => end - start + 1 <= HISTORY_CHUNK_ROWS)).toBe(true);
    expect(ctx.copyModeStates[pid('%1')].loadedRanges).toEqual([[0, history + 1]]);
    expect(ctx.copyModeStates[pid('%1')].loading).toBe(false);
  });
});
