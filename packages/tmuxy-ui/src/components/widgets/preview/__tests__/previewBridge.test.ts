import { describe, expect, it } from 'vitest';
import { bridgeScript, newBridgeChannel, readBridgeMessage } from '../previewBridge';

const TOKEN = 'a1b2c3';
const wrap = (m: unknown) => ({ tmuxyPreview: m, token: TOKEN });
const read = (data: unknown) => readBridgeMessage(data, TOKEN);

describe('the preview bridge', () => {
  it('reads the four messages it sends', () => {
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
    expect(script).toContain('({"x":0,"y":340},{"token":"a1b2c3","targetOrigin":"http://app"})');
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
});
