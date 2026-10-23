/**
 * The guest drivers' marker books hold invariant A6 on the console transport:
 * the BEGIN marker, the command and the END marker are three lines, so the
 * END marker runs whatever the command did. tmux stops a `;` list at its
 * first error — on one line, a refused split's END marker never ran, the
 * tracker waited out its timeout swallowing every reply behind it, and the
 * user read "tmux did not respond" for a split tmux had refused at once.
 */
import { describe, expect, it, vi } from 'vitest';
import { CaptureBook, TrackedCommandBook } from '../controlMode';

describe('TrackedCommandBook', () => {
  it('sends its markers as their own lines, so the END marker runs whatever the command did', () => {
    const book = new TrackedCommandBook();
    const sent: string[] = [];
    void book.sendTracked(
      'split-window -v',
      (line) => sent.push(line),
      () => {},
    );
    expect(sent).toEqual([
      "display-message -p 'TMUXY_RC_1'",
      'split-window -v',
      "display-message -p 'TMUXY_RC_END_1'",
    ]);
  });

  it("a command tmux refuses resolves with tmux's reason as soon as its END marker answers", async () => {
    vi.useFakeTimers();
    try {
      const book = new TrackedCommandBook();
      const onTimeout = vi.fn();
      const result = book.sendTracked('split-window -v', () => {}, onTimeout);
      book.onResponse(true, 'TMUXY_RC_1');
      book.onResponse(false, 'no space for a new pane');
      book.onResponse(true, 'TMUXY_RC_END_1');
      await expect(result).resolves.toEqual({ ok: false, message: 'no space for a new pane' });
      vi.advanceTimersByTime(60_000);
      expect(onTimeout).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a refused command does not take the one queued behind it down with it', async () => {
    const book = new TrackedCommandBook();
    const onTimeout = vi.fn();
    const first = book.sendTracked('split-window -v', () => {}, onTimeout);
    const second = book.sendTracked('split-window -h', () => {}, onTimeout);
    book.onResponse(true, 'TMUXY_RC_1');
    book.onResponse(false, 'no space for a new pane');
    book.onResponse(true, 'TMUXY_RC_END_1');
    book.onResponse(true, 'TMUXY_RC_2');
    book.onResponse(true, '');
    book.onResponse(true, 'TMUXY_RC_END_2');
    await expect(first).resolves.toEqual({ ok: false, message: 'no space for a new pane' });
    await expect(second).resolves.toEqual({ ok: true, message: '' });
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

describe('CaptureBook', () => {
  it('sends its markers as their own lines', () => {
    const book = new CaptureBook();
    const sent: string[] = [];
    void book.capture('capture-pane -t %4 -p -e -S -100 -E -1', (line) => sent.push(line));
    expect(sent).toEqual([
      "display-message -p 'TMUXY_CAP_START_1'",
      'capture-pane -t %4 -p -e -S -100 -E -1',
      "display-message -p 'TMUXY_CAP_END_1'",
    ]);
  });

  it('a capture of a pane that is gone resolves empty, not with the error text as history', async () => {
    const book = new CaptureBook();
    const text = book.capture('capture-pane -t %9 -p -e -S -10 -E -1', () => {});
    book.scanChunk(
      [
        '%begin 1 1 1',
        'TMUXY_CAP_START_1',
        '%end 1 1 1',
        '%begin 1 2 1',
        "can't find pane: %9",
        '%error 1 2 1',
        '%begin 1 3 1',
        'TMUXY_CAP_END_1',
        '%end 1 3 1',
        '',
      ].join('\r\n'),
    );
    await expect(text).resolves.toBe('');
  });

  it('a capture that succeeds keeps every line between its markers', async () => {
    const book = new CaptureBook();
    const text = book.capture('capture-pane -t %2 -p -e -S -2 -E -1', () => {});
    book.scanChunk('%begin 1 1 1\r\nTMUXY_CAP_START_1\r\n%end 1 1 1\r\n%begin 1 2 1\r\nfirst\r\n');
    book.scanChunk('second\r\n%end 1 2 1\r\n%begin 1 3 1\r\nTMUXY_CAP_END_1\r\n%end 1 3 1\r\n');
    await expect(text).resolves.toBe('first\nsecond');
  });
});
