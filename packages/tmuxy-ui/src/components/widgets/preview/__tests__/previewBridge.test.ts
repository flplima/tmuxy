import { describe, expect, it, vi } from 'vitest';
import {
  bridgeScript,
  EMIT_MAX_BYTES,
  EMIT_RATE,
  emitBudget,
  emitLine,
  newBridgeChannel,
  pageChord,
  readBridgeMessage,
} from '../previewBridge';
import { asciiJson } from '../../../../domain/commandHelpers';

const TOKEN = 'a1b2c3';
const wrap = (m: unknown) => ({ tmuxyPreview: m, token: TOKEN });
const read = (data: unknown) => readBridgeMessage(data, TOKEN);

describe('the preview bridge', () => {
  it('reads the messages it sends', () => {
    expect(read(wrap({ type: 'scroll', x: 0, y: 120.5 }))).toEqual({
      type: 'scroll',
      x: 0,
      y: 120.5,
    });
    expect(read(wrap({ type: 'title', title: 'Report' }))).toEqual({
      type: 'title',
      title: 'Report',
    });
    expect(
      read(
        wrap({
          type: 'key',
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          altKey: false,
          shiftKey: false,
        }),
      ),
    ).toEqual({
      type: 'key',
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
    });
    expect(read(wrap({ type: 'open', url: 'https://example.com/' }))).toEqual({
      type: 'open',
      url: 'https://example.com/',
    });
  });

  it('refuses anything else a page could post', () => {
    for (const data of [
      null,
      'scroll',
      { type: 'scroll', x: 0, y: 1 },
      wrap(null),
      wrap({ type: 'scroll', x: 'top', y: 0 }),
      wrap({ type: 'scroll', x: 0, y: Infinity }),
      // A plain key is the page's; only a chord crosses to the app.
      wrap({ type: 'key', key: 'a', code: 'KeyA', ctrlKey: false, altKey: false }),
      // Ctrl pressed on its own: the start of a chord, not one.
      wrap({ type: 'key', key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false }),
      wrap({ type: 'key', key: 'x'.repeat(100), code: 'KeyX', ctrlKey: true, altKey: false }),
      // Ctrl+Enter answers every question waiting in the tab.
      wrap({ type: 'key', key: 'Enter', code: 'Enter', ctrlKey: true, altKey: false }),
      wrap({ type: 'title', title: 'x'.repeat(1000) }),
      wrap({ type: 'run', command: 'rm -rf ~' }),
    ]) {
      expect(read(data)).toBeNull();
    }
  });

  it('scrolls the page to where it was, signing for and posting to the app alone', () => {
    const script = bridgeScript({ x: 0, y: 340 }, { token: TOKEN, targetOrigin: 'http://app' });
    expect(script).toContain('({"x":0,"y":340},{"token":"a1b2c3","targetOrigin":"http://app"},');
  });

  it('leaves a copy to the page while it has something to copy, and Ctrl+C to the app otherwise', () => {
    const chord = (key: string, mods: { shift?: boolean; alt?: boolean } = {}) => ({
      key,
      ctrlKey: true,
      altKey: mods.alt === true,
      shiftKey: mods.shift === true,
    });
    // Text selected, or the cursor in a field: Ctrl+C is the browser's copy,
    // and Ctrl+Shift+C, which the browser does not know, is copied for it.
    expect(pageChord(chord('c'), true)).toBe('native');
    expect(pageChord(chord('C', { shift: true }), true)).toBe('copy');
    // Nothing to copy: both are the app's, and Ctrl+C quits the preview.
    expect(pageChord(chord('c'), false)).toBe('post');
    expect(pageChord(chord('C', { shift: true }), false)).toBe('post');
    // Any other chord is the app's, selection or not.
    expect(pageChord(chord('b'), true)).toBe('post');
    expect(pageChord(chord('c', { alt: true }), true)).toBe('post');
    expect(pageChord({ ...chord('c'), ctrlKey: false, altKey: true }, true)).toBe('post');
    // The page runs it standalone, handed to the bridge.
    const script = bridgeScript({ x: 0, y: 0 }, { token: TOKEN, targetOrigin: 'http://app' });
    expect(script).toContain(`chordOf:${pageChord.toString()},`);
  });

  it('takes a message only with the token of the page it composed', () => {
    const { token, targetOrigin } = newBridgeChannel();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(newBridgeChannel().token).not.toBe(token);
    // The test document is served over http(s): the bridge posts to it alone.
    expect(targetOrigin).toBe(window.location.origin);
    const msg = { type: 'key', key: 'c', code: 'KeyC', ctrlKey: true, altKey: false };
    expect(readBridgeMessage({ tmuxyPreview: msg }, token)).toBeNull();
    expect(readBridgeMessage({ tmuxyPreview: msg, token: 'wrong' }, token)).toBeNull();
    expect(readBridgeMessage({ tmuxyPreview: msg, token }, token)).toEqual({
      ...msg,
      shiftKey: false,
    });
  });

  it('reads an emit as the line the app types: JSON, printable ASCII, within the limit', () => {
    expect(read(wrap({ type: 'emit', json: '{"action":"approve","n":2}' }))).toEqual({
      type: 'emit',
      json: '{"action":"approve","n":2}',
    });
    // Written out again by the app, whatever the page's realm did to the
    // bridge: its spacing gone, every other character escaped.
    expect(read(wrap({ type: 'emit', json: '{ "a" : "é " }' }))).toEqual({
      type: 'emit',
      json: '{"a":"\\u00e9\\u2028"}',
    });
    for (const json of [
      undefined,
      42,
      '{"a":',
      'not json',
      JSON.stringify('x'.repeat(EMIT_MAX_BYTES)),
      // Within the limit as sent, past it once the app writes it out.
      JSON.stringify('é'.repeat(EMIT_MAX_BYTES / 4)),
    ]) {
      expect(read(wrap({ type: 'emit', json }))).toBeNull();
    }
    // Signed with another page's token, it is no emit at all.
    expect(readBridgeMessage(wrap({ type: 'emit', json: '1' }), 'other')).toBeNull();
  });

  it('writes an emit as one line, and refuses what JSON cannot hold or the limit cannot take', () => {
    const line = (value: unknown) => emitLine(value, JSON.stringify, asciiJson, EMIT_MAX_BYTES);
    expect(line({ text: 'a\nb\u007f\u009b😀' })).toBe(
      '{"text":"a\\nb\\u007f\\u009b\\ud83d\\ude00"}',
    );
    expect(JSON.parse(line({ text: 'a\nb\u007f\u009b😀' }))).toEqual({
      text: 'a\nb\u007f\u009b😀',
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [undefined, () => 1, Symbol('s'), cycle, 1n]) {
      expect(() => line(value)).toThrow(TypeError);
    }
    expect(line('x'.repeat(EMIT_MAX_BYTES - 2))).toHaveLength(EMIT_MAX_BYTES);
    expect(() => line('x'.repeat(EMIT_MAX_BYTES - 1))).toThrow(RangeError);
  });

  it('keeps an emit budget: a burst, then so many a second, the rest dropped', () => {
    let now = 0;
    const take = emitBudget(EMIT_RATE.burst, EMIT_RATE.perSecond, () => now);
    const burst = Array.from({ length: EMIT_RATE.burst + 5 }, () => take());
    expect(burst.filter(Boolean)).toHaveLength(EMIT_RATE.burst);
    expect(burst.slice(EMIT_RATE.burst).some(Boolean)).toBe(false);
    now += 1000 / EMIT_RATE.perSecond;
    expect(take()).toBe(true);
    expect(take()).toBe(false);
    // An idle page gets its burst back, and no more.
    now += 60_000;
    expect(Array.from({ length: EMIT_RATE.burst + 1 }, () => take()).filter(Boolean)).toHaveLength(
      EMIT_RATE.burst,
    );
  });

  it("gives the page tmuxy.emit, which posts the value's line signed for the app", async () => {
    const posted: unknown[] = [];
    const listen = (e: MessageEvent) => posted.push(e.data);
    window.addEventListener('message', listen);
    try {
      const channel = { token: TOKEN, targetOrigin: window.location.origin };
      // The script as the page runs it: standalone, in the page's global
      // scope, whose parent is the app (here, the test's own window).
      // jsdom has no execCommand, which the bridge takes for a copy.
      vi.stubGlobal('parent', window);
      document.execCommand ??= () => false;
      (0, eval)(bridgeScript({ x: 0, y: 0 }, channel));
      const { emit } = (window as unknown as { tmuxy: { emit(value: unknown): boolean } }).tmuxy;
      expect(emit({ verdict: 'approve', note: 'é' })).toBe(true);
      expect(() => emit(undefined)).toThrow(TypeError);
      expect(() => emit('x'.repeat(EMIT_MAX_BYTES))).toThrow(RangeError);
      // A page that emits in a loop is dropped past its budget.
      const loop = Array.from({ length: 100 }, () => emit(1));
      expect(loop.filter(Boolean).length).toBeLessThanOrEqual(EMIT_RATE.burst);
      expect(loop[loop.length - 1]).toBe(false);
      await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
      expect(read(posted[0])).toEqual({
        type: 'emit',
        json: '{"verdict":"approve","note":"\\u00e9"}',
      });
    } finally {
      window.removeEventListener('message', listen);
      vi.unstubAllGlobals();
    }
  });
});
