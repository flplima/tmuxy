/**
 * Copy on select, as the Claude Code TUI does it: the mouse release that
 * ends a selection over terminal text puts the text on the clipboard and
 * says how many characters went; the selection stays. The next key clears
 * it and is processed as typed — Ctrl+C reaches the pane as an interrupt, a
 * letter as itself, Cmd+C as a copy of the same text. A modifier alone
 * leaves the selection; a release that leaves the same text selected copies
 * nothing twice.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pid } from '../../../test/wire';
import { pressKey, sendCommands, spawnKeyboardActor } from './keyboardHarness';
import * as mobileKeyboard from '../../../infra/dom/mobileKeyboard';

type Ev = { type: string; [k: string]: unknown };

const notices = (events: Ev[]) => events.filter((e) => e.type === 'NOTIFY').map((e) => e.text);

/** A terminal row of styled runs, as the renderer builds it. */
function mountRow(runs: string[]): HTMLElement {
  const grid = document.createElement('pre');
  grid.className = 'terminal-content';
  const row = document.createElement('div');
  row.className = 'terminal-line';
  for (const run of runs) {
    const span = document.createElement('span');
    span.textContent = run;
    row.appendChild(span);
  }
  grid.appendChild(row);
  document.body.appendChild(grid);
  return row;
}

/** Select `text` inside the row's first run, as a drag over it would. */
function select(row: HTMLElement, text: string) {
  const node = row.children[0].firstChild as Text;
  const start = node.data.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const release = () => window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
const selectedText = () => window.getSelection()?.toString() ?? '';

describe('keyboardActor — copy on select', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  let row: HTMLElement;
  let copied: string[];

  beforeEach(() => {
    vi.spyOn(mobileKeyboard, 'touchIsPrimary').mockReturnValue(false);
    // jsdom lays nothing out: the copy blink has no rectangles to cover.
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    copied = [];
    // jsdom has no clipboard: the copy event is what carries the text.
    document.execCommand = vi.fn(() => {
      const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent;
      const data: Record<string, string> = {};
      Object.defineProperty(event, 'clipboardData', {
        value: {
          setData: (_t: string, v: string) => void (data.text = v),
          getData: () => data.text,
        },
      });
      window.dispatchEvent(event);
      copied.push(data.text);
      return true;
    });
    row = mountRow(['$ echo DRAG_ME please', '  ']);
    handle = spawnKeyboardActor(pid('%3'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.getSelection()?.removeAllRanges();
    document.body.innerHTML = '';
  });

  it('the release that ends a selection copies it, says how many characters, and leaves it selected', () => {
    select(row, 'DRAG_ME');
    release();
    expect(copied).toEqual(['DRAG_ME']);
    expect(notices(handle.events)).toEqual(['Copied 7 characters']);
    expect(selectedText()).toBe('DRAG_ME');
  });

  /**
   * Firefox, in the pointer event that ends a drag over a pane: the range
   * holds the text and `Selection.toString()` is empty. The pane's wrapper
   * has the focus, as the press gave it; nothing was selected as far as a
   * `toString()` could tell, so the release handed the keyboard to the hidden
   * input and the selection was gone before it was copied.
   */
  it('keeps and copies a selection the browser stringifies as empty', () => {
    const wrapper = document.createElement('div');
    wrapper.dataset.paneId = '%3';
    wrapper.tabIndex = -1;
    document.body.appendChild(wrapper);
    wrapper.appendChild(row.parentElement as HTMLElement);
    // The hidden input outlives a test's document: back in the page, so that
    // focusing it is a focus that happens.
    const input = mobileKeyboard.getMobileInput();
    if (input) document.body.appendChild(input);
    vi.spyOn(Selection.prototype, 'toString').mockReturnValue('');

    window.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    wrapper.focus();
    select(row, 'DRAG_ME');
    window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
    release();

    expect(document.activeElement).toBe(wrapper);
    expect(window.getSelection()?.getRangeAt(0).toString()).toBe('DRAG_ME');
    expect(copied).toEqual(['DRAG_ME']);
    expect(notices(handle.events)).toEqual(['Copied 7 characters']);
  });

  it('a release with the same text still selected copies nothing twice', () => {
    select(row, 'DRAG_ME');
    release();
    release();
    expect(copied).toEqual(['DRAG_ME']);
    expect(notices(handle.events)).toHaveLength(1);
  });

  it('a release with nothing selected copies nothing', () => {
    release();
    expect(copied).toEqual([]);
    expect(notices(handle.events)).toEqual([]);
  });

  it('a letter clears the selection and is typed into the pane', () => {
    select(row, 'DRAG_ME');
    release();
    pressKey({ key: 'x' });
    expect(selectedText()).toBe('');
    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- 'x'"]);
  });

  it('Ctrl+C clears the selection and interrupts the shell', () => {
    select(row, 'DRAG_ME');
    release();
    pressKey({ key: 'c', ctrlKey: true });
    expect(selectedText()).toBe('');
    expect(handle.events.some((e) => e.type === 'COPY_SELECTION')).toBe(true);
  });

  it('Cmd+C copies the same text once more, then clears the selection', () => {
    select(row, 'DRAG_ME');
    release();
    pressKey({ key: 'c', code: 'KeyC', metaKey: true });
    expect(copied).toEqual(['DRAG_ME', 'DRAG_ME']);
    expect(selectedText()).toBe('');
  });

  it('a modifier on its own leaves the selection', () => {
    select(row, 'DRAG_ME');
    release();
    pressKey({ key: 'Shift', shiftKey: true });
    pressKey({ key: 'Meta', metaKey: true });
    expect(selectedText()).toBe('DRAG_ME');
  });

  it('the same text selected again after the selection went is copied again', () => {
    select(row, 'DRAG_ME');
    release();
    pressKey({ key: 'x' });
    select(row, 'DRAG_ME');
    release();
    expect(copied).toEqual(['DRAG_ME', 'DRAG_ME']);
    expect(notices(handle.events)).toHaveLength(2);
  });
});
