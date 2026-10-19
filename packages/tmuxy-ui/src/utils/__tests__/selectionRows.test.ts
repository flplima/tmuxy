import { afterEach, describe, expect, it } from 'vitest';
import { markSelectedRows } from '../selectionRows';

/** A selectable grid of rows, each string one row's text ('' an empty row). */
function grid(...texts: string[]): HTMLElement[] {
  const content = document.createElement('div');
  content.className = 'terminal-content terminal-selectable';
  const rows = texts.map((text) => {
    const row = document.createElement('div');
    row.className = 'terminal-line';
    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      row.appendChild(span);
    }
    content.appendChild(row);
    return row;
  });
  document.body.appendChild(content);
  return rows;
}

function select(from: Node, fromOffset: number, to: Node, toOffset: number): Selection {
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.setStart(from, fromOffset);
  range.setEnd(to, toOffset);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

const marked = (rows: HTMLElement[]) =>
  rows.map((r) => r.classList.contains('terminal-line-selected-on'));

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  markSelectedRows(null);
  document.body.innerHTML = '';
});

describe('the rows a selection runs past', () => {
  it('are every selected row but the last, an empty one among them', () => {
    const rows = grid('first line', '', 'third line', 'fourth');
    const text = (i: number) => rows[i].firstChild!.firstChild!;
    markSelectedRows(select(text(0), 3, text(2), 4));
    expect(marked(rows)).toEqual([true, true, false, false]);
  });

  it('are none for a selection inside one row', () => {
    const rows = grid('only line', 'next');
    const text = rows[0].firstChild!.firstChild!;
    markSelectedRows(select(text, 0, text, 4));
    expect(marked(rows)).toEqual([false, false]);
  });

  it('are unmarked when the selection goes', () => {
    const rows = grid('a line', 'b line');
    const a = rows[0].firstChild!.firstChild!;
    const b = rows[1].firstChild!.firstChild!;
    markSelectedRows(select(a, 0, b, 2));
    expect(marked(rows)).toEqual([true, false]);
    document.getSelection()!.removeAllRanges();
    markSelectedRows(document.getSelection());
    expect(marked(rows)).toEqual([false, false]);
  });
});
