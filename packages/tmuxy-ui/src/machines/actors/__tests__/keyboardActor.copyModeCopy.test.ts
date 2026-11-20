/**
 * Copying a selection copy mode drew says how many characters went, as copy
 * on select does: `y`, `Enter` and Cmd/Ctrl+C in copy mode, and the copy
 * chord on the scroll view's select-all. The notice waits for the write; one
 * the browser refused says it could not copy instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pid } from '../../../test/wire';
import { copyModeView } from '../../../test/model';
import { pressKey, spawnKeyboardActor } from './keyboardHarness';
import { fakeClipboardApi, fakeCopyCommand, settle } from '../../../test/clipboard';
import type { CopyModeState } from '../../../domain/copyMode';
import type { AppMachineContext } from '../../types/context';

type Ev = { type: string; [k: string]: unknown };

const notices = (events: Ev[]) =>
  events.filter((e) => e.type === 'NOTIFY').map((e) => ({ kind: e.kind, text: e.text }));

/** Copy mode on %3 with "hello" selected on its first row. */
const copyView = (extra: Partial<CopyModeState> = {}) =>
  copyModeView({
    selectionMode: 'char',
    selectionAnchor: { row: 10, col: 0 },
    cursorCol: 4,
    ...extra,
  });

const spawnIn = (view: CopyModeState) =>
  spawnKeyboardActor(pid('%3'), {
    copyModeStates: { [pid('%3')]: view } as AppMachineContext['copyModeStates'],
  });

describe('keyboardActor — copying in copy mode says so', () => {
  let copy: ReturnType<typeof fakeCopyCommand>;

  beforeEach(() => {
    copy = fakeCopyCommand();
  });
  afterEach(() => {
    copy.restore();
    fakeClipboardApi();
    vi.restoreAllMocks();
  });

  it.each([
    ['y', { key: 'y' }],
    ['Enter', { key: 'Enter' }],
    ['Ctrl+C', { key: 'c', code: 'KeyC', ctrlKey: true }],
    ['Cmd+C', { key: 'c', code: 'KeyC', metaKey: true }],
  ])('%s copies the selection and says how many characters went', (_name, key) => {
    const { events } = spawnIn(copyView());

    pressKey(key);

    expect(copy.copied).toEqual(['hello']);
    expect(notices(events)).toEqual([{ kind: 'info', text: 'Copied 5 characters' }]);
  });

  it('the copy chord on a select-all in the scroll view says it too', () => {
    const { events } = spawnIn(
      copyView({ mode: 'scroll', selectionMode: 'line', cursorRow: 11, cursorCol: 0 }),
    );

    pressKey({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });

    expect(copy.copied).toEqual(['hello world\nsecond line']);
    expect(notices(events)).toEqual([{ kind: 'info', text: 'Copied 23 characters' }]);
    expect(events.filter((e) => e.type === 'COPY_SELECTION')).toHaveLength(1);
  });

  it('a yank with nothing selected copies nothing and says nothing', () => {
    const { events } = spawnIn(copyView({ selectionMode: null, selectionAnchor: null }));

    pressKey({ key: 'y' });

    expect(copy.command).not.toHaveBeenCalled();
    expect(notices(events)).toEqual([]);
  });

  describe('when the browser takes no copy command', () => {
    beforeEach(() => copy.refuse());

    it('says copied once the clipboard API has taken the text', async () => {
      const written: string[] = [];
      fakeClipboardApi(async (text) => void written.push(text));
      const { events } = spawnIn(copyView());

      pressKey({ key: 'y' });
      expect(notices(events)).toEqual([]);
      await settle();

      expect(written).toEqual(['hello']);
      expect(notices(events)).toEqual([{ kind: 'info', text: 'Copied 5 characters' }]);
    });

    it('says it could not copy when the clipboard API refuses too', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      fakeClipboardApi(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
      const { events } = spawnIn(copyView());

      pressKey({ key: 'y' });
      await settle();

      expect(notices(events)).toEqual([
        {
          kind: undefined,
          text: 'Could not copy 5 chars: the browser wants a key or a click first',
        },
      ]);
    });
  });
});
