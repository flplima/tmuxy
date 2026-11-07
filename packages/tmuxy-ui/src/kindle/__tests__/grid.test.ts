import { describe, expect, it } from 'vitest';
import type { ClientState } from '../../domain/client';
import type { CellLine } from '../../domain/wireCells';
import { modelPane, modelWindow } from '../../test/model';
import { pid, wid } from '../../test/wire';
import { kindleView, type KindleView } from '../grid';

const line = (text: string): CellLine => Array.from(text, (c) => ({ c }));

const session = (overrides: Partial<ClientState>): ClientState => ({
  sessionName: 's',
  activeWindowId: null,
  activePaneId: null,
  totalWidth: 0,
  totalHeight: 0,
  focusRequest: '',
  pluginsRev: '',
  themeRev: '',
  panes: [],
  windows: [],
  ...overrides,
});

const text = (view: KindleView): string[] =>
  view.rows.map((row) => row.map((run) => run.text).join(''));

describe('kindleView', () => {
  it('draws the active tab’s panes side by side, lists only tabs, and marks the keyboard pane’s cursor', () => {
    const view = kindleView(
      session({
        activeWindowId: wid('@1'),
        windows: [
          modelWindow(wid('@1'), 1, { name: 'code' }),
          modelWindow(wid('@2'), 2, { name: 'logs' }),
          modelWindow(wid('@3'), 3, { windowType: 'float' }),
          modelWindow(wid('@4'), 4, { windowType: 'sidebar-left' }),
        ],
        panes: [
          modelPane(pid('%1'), wid('@1'), {
            width: 3,
            height: 2,
            content: [line('ab'), line('cd')],
          }),
          modelPane(pid('%2'), wid('@1'), {
            x: 4,
            width: 3,
            height: 2,
            active: true,
            cursorX: 1,
            cursorY: 0,
            content: [line('xyz'), line('uvw')],
          }),
          modelPane(pid('%3'), wid('@2'), { content: [line('elsewhere')] }),
        ],
      }),
    );

    expect(view.tabs.map((t) => [t.label, t.active])).toEqual([
      ['1:code', true],
      ['2:logs', false],
    ]);
    expect(view.target).toBe('%2');
    expect(text(view)).toEqual(['ab │xyz', 'cd │uvw']);
    // Exactly one inverted cell: the cursor, on `y` in the keyboard's pane.
    const inverted = view.rows.flatMap((row) => row.filter((run) => run.inverse));
    expect(inverted.map((run) => run.text)).toEqual(['y']);
  });

  it('draws only the zoomed pane of a zoomed tab, at the origin', () => {
    const view = kindleView(
      session({
        activeWindowId: wid('@1'),
        windows: [modelWindow(wid('@1'), 1, { zoomed: true })],
        panes: [
          modelPane(pid('%1'), wid('@1'), { width: 2, height: 1, content: [line('no')] }),
          modelPane(pid('%2'), wid('@1'), {
            x: 3,
            width: 3,
            height: 1,
            active: true,
            cursorHidden: true,
            content: [line('yes')],
          }),
        ],
      }),
    );

    expect(text(view)).toEqual(['yes']);
    expect(view.panes).toEqual([{ id: '%2', x: 0, y: 0, width: 3, height: 1 }]);
  });

  it('keeps the rest of a row in its columns after a wide character', () => {
    const view = kindleView(
      session({
        activeWindowId: wid('@1'),
        windows: [modelWindow(wid('@1'), 1)],
        panes: [
          modelPane(pid('%1'), wid('@1'), {
            width: 4,
            height: 1,
            cursorHidden: true,
            // tmux gives 漢 two cells: the glyph, then a blank it reserves.
            content: [[{ c: '漢' }, { c: ' ' }, { c: 'a' }, { c: 'b' }]],
          }),
        ],
      }),
    );

    expect(text(view)).toEqual(['漢ab']);
  });
});
