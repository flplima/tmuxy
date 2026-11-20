/**
 * A drag released in copy mode, or a phone's Copy, copies what it selected,
 * says how many characters went and leaves, the way tmux's
 * MouseDragEnd1Pane runs copy-pipe-and-cancel; the view stays for the blink.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pid } from '../../../../test/wire';
import { copyModeState } from '../copyMode';
import { copyModeActions } from '../../actions/copyMode';
import { act } from '../../actionTypes';
import { COPY_FLASH_MS } from '../../../../infra/dom/copyFlash';
import { mountState, sendAndGetContext } from './testHarness';
import type { CopyModeState } from '../../../../domain/copyMode';
import { toTmuxCommand } from '../../../../domain/commands';
import { copyModeView } from '../../../../test/model';
import { recorder } from '../../../../test/app';
import { fakeClipboardApi, fakeCopyCommand, settle } from '../../../../test/clipboard';

describe('copyMode state — copying with the mouse', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The slice with every NOTIFY it raises recorded. */
  const mountRecordingNotices = (extra: Parameters<typeof mountState>[3] = {}) => {
    const notices: Array<{ kind?: string; text: string }> = [];
    const actor = mountState(
      { on: { ...copyModeState.on, NOTIFY: { actions: 'recordNotice' } } },
      {
        ...copyModeActions,
        recordNotice: act(({ event }) => {
          if (event.type === 'NOTIFY') notices.push({ kind: event.kind, text: event.text });
        }),
      },
      { copyModeStates: { [pid('%1')]: withSelection() } },
      extra,
    );
    return { actor, notices };
  };

  /** A copy-mode view with "hello" selected on its first loaded row. */
  const withSelection = (extra: Partial<CopyModeState> = {}) =>
    copyModeView({
      selectionMode: 'char',
      selectionAnchor: { row: 10, col: 0 },
      cursorRow: 10,
      cursorCol: 4,
      ...extra,
    });

  it('a released drag copies the selection, says how many characters went, leaves tmux copy mode at once, and closes the view after the blink', () => {
    // tmux's MouseDragEnd1Pane runs copy-pipe-and-cancel: copy, then leave.
    // The client does the same, except that its view stays for the blink so
    // the copied text flashes where it is, then goes.
    vi.useFakeTimers();
    const copy = fakeCopyCommand();
    const tmux = recorder();
    const sent = () => tmux.ops().map(toTmuxCommand);
    const { actor, notices } = mountRecordingNotices({ extraActors: { tmux: tmux.logic } });

    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_MOUSE_COPY', paneId: pid('%1') });
    copy.restore();
    expect(copy.copied).toEqual(['hello']);
    const win = globalThis as unknown as { __tmuxyLastClipboard?: { text: string } };
    expect(win.__tmuxyLastClipboard?.text).toBe('hello');
    expect(notices).toEqual([{ kind: 'info', text: 'Copied 5 characters' }]);
    expect(sent()).toContain('send-keys -t %1 -X cancel');
    expect(ctx.copyModeStates[pid('%1')]?.copiedAt).toEqual(expect.any(Number));

    vi.advanceTimersByTime(COPY_FLASH_MS - 1);
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]).toBeUndefined();
  });

  it('a release the browser would not copy says so, and still leaves', async () => {
    // A page with no copy command and no clipboard API: http off localhost.
    fakeClipboardApi();
    const { actor, notices } = mountRecordingNotices();

    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_MOUSE_COPY', paneId: pid('%1') });
    await settle();

    expect(notices).toEqual([
      {
        kind: undefined,
        text: 'Could not copy 5 chars: no clipboard without https or localhost',
      },
    ]);
    expect(ctx.copyModeStates[pid('%1')]?.copiedAt).toEqual(expect.any(Number));
  });

  it('a drag that selected nothing copies nothing and stays in copy mode', () => {
    const actor = mountState(copyModeState, copyModeActions, {
      copyModeStates: { [pid('%1')]: copyModeView() },
    });
    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_MOUSE_COPY', paneId: pid('%1') });
    expect(ctx.copyModeStates[pid('%1')]?.copiedAt).toBeUndefined();
  });

  it('the end of a blink closes only the view that copy left, not one opened since', () => {
    const actor = mountState(copyModeState, copyModeActions, {
      copyModeStates: { [pid('%1')]: withSelection({ copiedAt: 200 }) },
    });
    const ctx = sendAndGetContext(actor, {
      type: 'COPY_MODE_COPIED_EXIT',
      paneId: pid('%1'),
      copiedAt: 100,
    });
    expect(ctx.copyModeStates[pid('%1')]).toBeDefined();
  });

  it('a keyboard yank blinks and closes the same way', () => {
    vi.useFakeTimers();
    const actor = mountState(copyModeState, copyModeActions, {
      copyModeStates: { [pid('%1')]: withSelection() },
    });
    const ctx = sendAndGetContext(actor, { type: 'COPY_MODE_YANK', paneId: pid('%1') });
    expect(ctx.copyModeStates[pid('%1')]?.copiedAt).toEqual(expect.any(Number));
    vi.advanceTimersByTime(COPY_FLASH_MS);
    expect(actor.getSnapshot().context.copyModeStates[pid('%1')]).toBeUndefined();
  });
});
