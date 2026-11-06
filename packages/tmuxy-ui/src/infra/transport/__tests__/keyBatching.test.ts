import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyBatcher, unescapeLiteralText } from '../keyBatching';
import { quote, toTmuxCommand, TmuxOp } from '../../../domain/commands';
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

  it('sends key names that start with a flag alone, and any op that is not a keystroke', async () => {
    expect(special('-X cancel')).toBe(false);
    expect(
      batcher.take(TmuxOp.SendMouse({ paneId: pid('%1'), button: 0, x: 1, y: 1, release: false })),
    ).toBe(false);
    expect(batcher.take(TmuxOp.SelectPane({ paneId: pid('%1') }))).toBe(false);
    expect(sent).toHaveLength(0);
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

describe('quote / unescapeLiteralText', async () => {
  it('round-trips plain and quoted text', async () => {
    for (const text of ['abc', "it's", "a'b'c", ' spaced  ', "'"]) {
      expect(unescapeLiteralText(quote(text))).toBe(text);
    }
  });
});
