import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyBatcher } from '../keyBatching';
import { toTmuxCommand, TmuxOp } from '../../../domain/commands';
import { quote } from '../../../domain/commandHelpers';
import { pid } from '../../../test/wire';

describe('KeyBatcher', async () => {
  let sent: string[];
  let batcher: KeyBatcher;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    batcher = new KeyBatcher((op) => sent.push(toTmuxCommand(op)));
  });

  afterEach(() => {
    batcher.destroy();
    vi.useRealTimers();
  });

  const literal = (text: string, target = 's0') => batcher.take(TmuxOp.SendText({ target, text }));
  const special = (keys: string, target = 's0') => batcher.take(TmuxOp.SendKeys({ target, keys }));

  it('sends an isolated literal keystroke immediately (leading edge)', async () => {
    expect(literal('a')).toBe(true);
    expect(sent).toEqual(["send-keys -t s0 -l -- 'a'"]);
    // Nothing pending — the window closes empty and no duplicate follows.
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);
  });

  it('sends an isolated special key immediately (leading edge)', async () => {
    expect(special('Enter')).toBe(true);
    expect(sent).toEqual(['send-keys -t s0 Enter']);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(1);
  });

  it('batches for a quoted target as for any other, quoting it once on the way out', async () => {
    // A session name with a space is the one target that goes out quoted.
    literal('a', 'my work');
    literal('b', 'my work');
    await vi.advanceTimersByTimeAsync(16);
    expect(sent).toEqual(["send-keys -t 'my work' -l -- 'a'", "send-keys -t 'my work' -l -- 'b'"]);
  });

  it('coalesces a rapid literal burst after the leading send', async () => {
    literal('a');
    await vi.advanceTimersByTimeAsync(5);
    literal('b');
    literal('c');
    expect(sent).toEqual(["send-keys -t s0 -l -- 'a'"]); // b, c wait for the window
    await vi.advanceTimersByTimeAsync(11); // window closes at 16ms
    expect(sent).toEqual(["send-keys -t s0 -l -- 'a'", "send-keys -t s0 -l -- 'bc'"]);
  });

  it('keeps coalescing under sustained input (window stays open after a non-empty flush)', async () => {
    literal('a'); // leading send, window opens
    await vi.advanceTimersByTimeAsync(10);
    literal('b');
    await vi.advanceTimersByTimeAsync(6); // first trailing flush: 'b', window re-opens
    literal('c'); // arrives inside the re-opened window — must NOT send immediately
    expect(sent).toEqual(["send-keys -t s0 -l -- 'a'", "send-keys -t s0 -l -- 'b'"]);
    await vi.advanceTimersByTimeAsync(16); // second trailing flush: 'c'
    expect(sent).toEqual([
      "send-keys -t s0 -l -- 'a'",
      "send-keys -t s0 -l -- 'b'",
      "send-keys -t s0 -l -- 'c'",
    ]);
    // Stream stopped — window closes and the next key is leading again.
    await vi.advanceTimersByTimeAsync(16);
    literal('d');
    expect(sent).toHaveLength(4);
    expect(sent[3]).toBe("send-keys -t s0 -l -- 'd'");
  });

  it('normal typing speed never waits: keys spaced past the window all send immediately', async () => {
    literal('a');
    await vi.advanceTimersByTimeAsync(100);
    literal('b');
    await vi.advanceTimersByTimeAsync(100);
    literal('c');
    expect(sent).toEqual([
      "send-keys -t s0 -l -- 'a'",
      "send-keys -t s0 -l -- 'b'",
      "send-keys -t s0 -l -- 'c'",
    ]);
  });

  it('preserves literal→special cross-batch ordering', async () => {
    literal('a');
    await vi.advanceTimersByTimeAsync(5);
    literal('b'); // pending in the window
    special('Enter'); // must flush pending 'b' first, then send Enter
    expect(sent).toEqual([
      "send-keys -t s0 -l -- 'a'",
      "send-keys -t s0 -l -- 'b'",
      'send-keys -t s0 Enter',
    ]);
  });

  it('preserves special→literal cross-batch ordering', async () => {
    special('Up');
    await vi.advanceTimersByTimeAsync(5);
    special('Down'); // pending
    literal('x'); // must flush pending Down first, then send x
    expect(sent).toEqual([
      'send-keys -t s0 Up',
      'send-keys -t s0 Down',
      "send-keys -t s0 -l -- 'x'",
    ]);
  });

  it('joins special keys pending in the same window into one send', async () => {
    special('Up');
    await vi.advanceTimersByTimeAsync(5);
    special('Down');
    special('Left');
    await vi.advanceTimersByTimeAsync(11);
    expect(sent).toEqual(['send-keys -t s0 Up', 'send-keys -t s0 Down Left']);
  });

  it('sends key names that start with a flag alone, and any op that is not an input', async () => {
    expect(special('-X cancel')).toBe(false);
    expect(batcher.take(TmuxOp.SelectPane({ paneId: pid('%1') }))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  describe('mouse reports', () => {
    const PANE = pid('%1');
    const mouse = (button: number, x: number, y = 1, release = false) =>
      batcher.take(TmuxOp.SendMouse({ paneId: PANE, reports: [{ button, x, y, release }] }));
    const DRAG = 32; // the left button held, moving
    const command = (...reports: Array<[button: number, x: number, release?: boolean]>) =>
      toTmuxCommand(
        TmuxOp.SendMouse({
          paneId: PANE,
          reports: reports.map(([button, x, release = false]) => ({ button, x, y: 1, release })),
        }),
      );

    it('sends a lone click at once', async () => {
      expect(mouse(0, 5)).toBe(true);
      expect(sent).toEqual([command([0, 5])]);
      await vi.advanceTimersByTimeAsync(100);
      expect(sent).toHaveLength(1);
    });

    it('sends a drag as one command a frame, carrying where the pointer got to', async () => {
      mouse(0, 1); // press: leading, sent at once
      // 60 cells crossed in 120ms: a pointer event every 2ms.
      for (let x = 2; x <= 61; x++) {
        mouse(DRAG, x);
        await vi.advanceTimersByTimeAsync(2);
      }
      mouse(0, 61, 1, true);
      await vi.advanceTimersByTimeAsync(16);

      // A command a frame, not 62 of them; the release last, after the
      // final position.
      expect(sent.length).toBeLessThanOrEqual(9);
      expect(sent[0]).toBe(command([0, 1]));
      expect(sent[sent.length - 1]).toBe(command([DRAG, 61], [0, 61, true]));
    });

    it('never sends a motion report that repeats the one before it', async () => {
      mouse(0, 5);
      await vi.advanceTimersByTimeAsync(16);
      // The pointer moves inside cell 6 for a second.
      for (let i = 0; i < 60; i++) {
        mouse(DRAG, 6);
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(sent).toEqual([command([0, 5]), command([DRAG, 6])]);
    });

    it('keeps every wheel step and every click of a burst, in order', async () => {
      const WHEEL_DOWN = 65;
      batcher.take(
        TmuxOp.SendMouse({
          paneId: PANE,
          reports: Array.from({ length: 3 }, () => ({
            button: WHEEL_DOWN,
            x: 4,
            y: 1,
            release: false,
          })),
        }),
      );
      mouse(WHEEL_DOWN, 4);
      mouse(0, 4);
      mouse(0, 4, 1, true);
      await vi.advanceTimersByTimeAsync(16);
      expect(sent).toEqual([
        command([WHEEL_DOWN, 4], [WHEEL_DOWN, 4], [WHEEL_DOWN, 4]),
        command([WHEEL_DOWN, 4], [0, 4], [0, 4, true]),
      ]);
    });

    it('keeps a key and a click in the order they happened', async () => {
      mouse(0, 5);
      mouse(DRAG, 6); // waits for the window
      batcher.take(TmuxOp.SendText({ target: PANE, text: 'x' }));
      expect(sent).toEqual([command([0, 5]), command([DRAG, 6]), "send-keys -t %1 -l -- 'x'"]);
    });
  });

  it('joins text holding control characters like any other, quoted for control mode', async () => {
    literal('a');
    await vi.advanceTimersByTimeAsync(5);
    literal('b');
    literal('c\td');
    await vi.advanceTimersByTimeAsync(11);
    expect(sent).toEqual(["send-keys -t s0 -l -- 'a'", `send-keys -t s0 -l -- ${quote('bc\td')}`]);
    expect(quote('bc\td').startsWith('"')).toBe(true);
  });

  it('flushAll drains pending batches and closes the windows', async () => {
    literal('a');
    await vi.advanceTimersByTimeAsync(5);
    literal('b'); // pending
    batcher.flushAll();
    expect(sent).toEqual(["send-keys -t s0 -l -- 'a'", "send-keys -t s0 -l -- 'b'"]);
    // Windows are closed — the next key is leading again.
    literal('c');
    expect(sent[2]).toBe("send-keys -t s0 -l -- 'c'");
  });

  it('keeps sessions separate within one window', async () => {
    literal('a'); // opens the literal window (leading, session s0)
    literal('z', 's1');
    await vi.advanceTimersByTimeAsync(16);
    expect(sent).toContain("send-keys -t s0 -l -- 'a'");
    expect(sent).toContain("send-keys -t s1 -l -- 'z'");
    expect(sent).toHaveLength(2);
  });
});
