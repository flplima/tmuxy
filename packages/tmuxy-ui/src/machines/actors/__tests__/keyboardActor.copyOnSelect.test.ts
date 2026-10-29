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
import { createActor, createMachine, type AnyActorRef } from 'xstate';
import { createKeyboardActor } from '../keyboardActor';
import { toTmuxCommand, type TmuxOp } from '../../../domain/commands';
import * as mobileKeyboard from '../../../utils/mobileKeyboard';

type Ev = { type: string; [k: string]: unknown };

function spawnKeyboardActor(activePaneId = pid('%3')) {
  const events: Ev[] = [];
  const keyboardActor = createKeyboardActor();
  const parent = createMachine({
    types: {} as {
      context: { activePaneId: string; copyModeStates: Record<string, unknown> };
      events: Ev;
    },
    context: { activePaneId, copyModeStates: {} },
    invoke: {
      id: 'keyboard',
      src: 'keyboardActor',
      input: ({ self }: { self: AnyActorRef }) => ({ parent: self }),
    },
    on: {
      '*': {
        actions: ({ event }) => {
          events.push(event as Ev);
        },
      },
    },
  }).provide({ actors: { keyboardActor }, actions: {} } as never);
  const actor = createActor(parent);
  actor.start();
  const child = actor.getSnapshot().children.keyboard as AnyActorRef;
  child.send({ type: 'UPDATE_ACTIVE_PANE', paneId: activePaneId });
  return { actor, events };
}

const sendCommands = (events: Ev[]) =>
  events
    .map((e) => (e.type === 'DISPATCH_OP' ? toTmuxCommand(e.op as TmuxOp) : undefined))
    .filter((c): c is string => c !== undefined);
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
const key = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
const selectedText = () => window.getSelection()?.toString() ?? '';

describe('keyboardActor — copy on select', () => {
  let handle: ReturnType<typeof spawnKeyboardActor>;
  let row: HTMLElement;
  let copied: string[];

  beforeEach(() => {
    vi.spyOn(mobileKeyboard, 'isTouchDevice').mockReturnValue(false);
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
    handle.actor.stop();
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
    key({ key: 'x' });
    expect(selectedText()).toBe('');
    expect(sendCommands(handle.events)).toEqual(["send-keys -t %3 -l -- 'x'"]);
  });

  it('Ctrl+C clears the selection and interrupts the shell', () => {
    select(row, 'DRAG_ME');
    release();
    key({ key: 'c', ctrlKey: true });
    expect(selectedText()).toBe('');
    expect(handle.events.some((e) => e.type === 'COPY_SELECTION')).toBe(true);
  });

  it('Cmd+C copies the same text once more, then clears the selection', () => {
    select(row, 'DRAG_ME');
    release();
    key({ key: 'c', code: 'KeyC', metaKey: true });
    expect(copied).toEqual(['DRAG_ME', 'DRAG_ME']);
    expect(selectedText()).toBe('');
  });

  it('a modifier on its own leaves the selection', () => {
    select(row, 'DRAG_ME');
    release();
    key({ key: 'Shift', shiftKey: true });
    key({ key: 'Meta', metaKey: true });
    expect(selectedText()).toBe('DRAG_ME');
  });

  it('the same text selected again after the selection went is copied again', () => {
    select(row, 'DRAG_ME');
    release();
    key({ key: 'x' });
    select(row, 'DRAG_ME');
    release();
    expect(copied).toEqual(['DRAG_ME', 'DRAG_ME']);
    expect(notices(handle.events)).toHaveLength(2);
  });
});
