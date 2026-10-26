import { describe, expect, it } from 'vitest';
import { bridgeScript, readBridgeMessage } from '../previewBridge';

const wrap = (m: unknown) => ({ tmuxyPreview: m });

describe('the preview bridge', () => {
  it('reads the four messages it sends', () => {
    expect(readBridgeMessage(wrap({ type: 'scroll', x: 0, y: 120.5 }))).toEqual({
      type: 'scroll',
      x: 0,
      y: 120.5,
    });
    expect(readBridgeMessage(wrap({ type: 'title', title: 'Report' }))).toEqual({
      type: 'title',
      title: 'Report',
    });
    expect(
      readBridgeMessage(
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
    expect(readBridgeMessage(wrap({ type: 'open', url: 'https://example.com/' }))).toEqual({
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
      expect(readBridgeMessage(data)).toBeNull();
    }
  });

  it('scrolls the page to where it was', () => {
    expect(bridgeScript({ x: 0, y: 340 })).toContain('({"x":0,"y":340})');
  });
});
