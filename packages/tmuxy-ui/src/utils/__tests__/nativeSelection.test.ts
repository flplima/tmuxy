import { describe, it, expect, afterEach } from 'vitest';
import { readNativeSelection, terminalTextOf } from '../nativeSelection';

/**
 * A terminal grid as the renderer builds it: rows of styled spans. Each span
 * is a flex item, which is what made the browser's own copy break a row at
 * every change of style.
 */
function mountGrid(rows: string[][]): HTMLElement {
  const grid = document.createElement('pre');
  grid.className = 'terminal-content';
  for (const runs of rows) {
    const row = document.createElement('div');
    row.className = 'terminal-line';
    for (const run of runs) {
      const span = document.createElement('span');
      span.textContent = run;
      row.appendChild(span);
    }
    grid.appendChild(row);
  }
  document.body.appendChild(grid);
  return grid;
}

function textNode(grid: HTMLElement, row: number, span: number): Text {
  return grid.querySelectorAll('.terminal-line')[row].children[span].firstChild as Text;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('terminalTextOf', () => {
  it('runs a row of differently-styled spans together', () => {
    const grid = mountGrid([['~/projects/tmuxy', ' ', 'main', '   ']]);
    const range = document.createRange();
    range.setStart(textNode(grid, 0, 0), 0);
    range.setEnd(textNode(grid, 0, 2), 4);
    expect(terminalTextOf(range)).toBe('~/projects/tmuxy main');
  });

  it('joins rows with one newline and drops their trailing padding', () => {
    const grid = mountGrid([
      ['first', ' row', '      '],
      ['second', '    '],
    ]);
    const range = document.createRange();
    range.setStart(textNode(grid, 0, 0), 2);
    range.setEnd(textNode(grid, 1, 0), 3);
    expect(terminalTextOf(range)).toBe('rst row\nsec');
  });

  it('ignores the next row when the selection only reaches its start', () => {
    // Dragging to the end of a row leaves the browser's selection ending at
    // offset 0 of the row below; that row was copied as a trailing newline.
    const grid = mountGrid([['RED_RUN', ' ', 'PLAIN_RUN'], ['next row']]);
    const range = document.createRange();
    range.setStart(textNode(grid, 0, 0), 0);
    range.setEnd(grid.querySelectorAll('.terminal-line')[1], 0);
    expect(terminalTextOf(range)).toBe('RED_RUN PLAIN_RUN');
  });

  it('keeps a blank row selected between two others', () => {
    const grid = mountGrid([['above'], [], ['below']]);
    const range = document.createRange();
    range.setStart(textNode(grid, 0, 0), 0);
    range.setEnd(textNode(grid, 2, 0), 5);
    expect(terminalTextOf(range)).toBe('above\n\nbelow');
  });

  it('leaves a selection outside the terminal to the browser', () => {
    const p = document.createElement('p');
    p.textContent = 'not a terminal';
    document.body.appendChild(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    expect(terminalTextOf(range)).toBeNull();
  });
});

describe('readNativeSelection', () => {
  it('reads the live selection the way a terminal copies it', () => {
    const grid = mountGrid([['RED_RUN', ' ', 'PLAIN_RUN']]);
    const range = document.createRange();
    range.setStart(textNode(grid, 0, 0), 0);
    range.setEnd(textNode(grid, 0, 2), 9);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readNativeSelection()).toBe('RED_RUN PLAIN_RUN');
  });

  it('is empty when nothing is selected', () => {
    expect(readNativeSelection()).toBe('');
  });
});
