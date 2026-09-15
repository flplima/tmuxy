/**
 * The browser widget's pure halves: reading its source out of pane content,
 * deciding how to show it, and deriving zoom and refresh from machine state.
 *
 * These are the pieces the rendered widget, the pane title and the ⋮ menu all
 * agree through — a disagreement here is a pane whose tab names one page while
 * the frame shows another.
 */

import { describe, it, expect } from 'vitest';
import { browserTitle, classifySource, loadUrl, parseColorFilter, parseSource } from '../source';
import { browserView, clampZoom, MAX_ZOOM, MIN_ZOOM } from '../view';
import type { BrowserPaneState } from '../../../../machines/types';

describe('parseSource', () => {
  it('reassembles a source that tmux wrapped across cell lines', () => {
    // A long URL in a narrow pane arrives split, with no separator to rejoin on.
    const lines = ['__SRC__:https://example.com/a/very/lo', 'ng/path/to/a/page.html'];
    expect(parseSource(lines)).toBe('https://example.com/a/very/long/path/to/a/page.html');
  });

  it('is empty until the marker arrives', () => {
    expect(parseSource([])).toBe('');
    expect(parseSource(['', ' '])).toBe('');
  });
});

describe('parseColorFilter', () => {
  it('is on when the script wrote the marker ahead of the source', () => {
    const lines = ['__COLOR_FILTER__', '__SRC__:https://example.com/'];
    expect(parseColorFilter(lines)).toBe(true);
    // ...and the source still reads as the source, marker and all ahead of it.
    expect(parseSource(lines)).toBe('https://example.com/');
  });

  it('is off without the marker', () => {
    expect(parseColorFilter(['__SRC__:/tmp/page.html'])).toBe(false);
    expect(parseColorFilter([])).toBe(false);
  });
});

describe('classifySource', () => {
  it.each([
    ['/home/me/notes.md', 'markdown'],
    ['/home/me/notes.MARKDOWN', 'markdown'],
    ['https://raw.example.com/README.md', 'markdown'],
    ['/home/me/shot.png', 'image'],
    ['https://example.com/logo.svg?v=2', 'image'],
    ['data:image/png;base64,AAAA', 'image'],
    ['/home/me/report/index.html', 'page'],
    ['https://example.com', 'page'],
    // A query string must not hide the extension, nor invent one.
    ['https://example.com/view?file=a.png', 'page'],
  ])('%s is shown as %s', (src, kind) => {
    expect(classifySource(src)).toBe(kind);
  });
});

describe('loadUrl', () => {
  it('sends a local path through the file route and leaves remote URLs alone', () => {
    expect(loadUrl('/home/me/a b.html')).toBe('/api/browse/home/me/a%20b.html');
    expect(loadUrl('file:///home/me/a.html')).toBe('/api/browse/home/me/a.html');
    expect(loadUrl('https://example.com/x')).toBe('https://example.com/x');
  });

  it('busts the cache only once a refresh has been asked for', () => {
    expect(loadUrl('https://example.com/x', 0)).toBe('https://example.com/x');
    expect(loadUrl('https://example.com/x', 2)).toBe('https://example.com/x?_tmuxyReload=2');
    expect(loadUrl('https://example.com/x?a=1', 2)).toBe(
      'https://example.com/x?a=1&_tmuxyReload=2',
    );
  });
});

describe('browserTitle', () => {
  it.each([
    ['https://github.com/flplima/tmuxy', 'github.com/flplima/tmuxy'],
    ['http://localhost:3000/', 'localhost:3000'],
    ['file:///home/me/a.html', '/home/me/a.html'],
    ['/home/me/notes.md', '/home/me/notes.md'],
  ])('%s reads as %s', (src, title) => {
    expect(browserTitle(src)).toBe(title);
  });
});

describe('browserView', () => {
  const lines = ['__SRC__:/home/me/index.html'];
  const state = (over: Partial<BrowserPaneState> = {}): BrowserPaneState => ({
    source: '/home/me/index.html',
    zoom: 1,
    reloadNonce: 0,
    ...over,
  });

  it('shows the pane marker source at zoom 1 before the user does anything', () => {
    expect(browserView(undefined, lines)).toEqual({
      url: '/home/me/index.html',
      zoom: 1,
      reloadNonce: 0,
    });
  });

  it("applies this browser's zoom and refreshes", () => {
    expect(browserView(state({ zoom: 2, reloadNonce: 3 }), lines)).toEqual({
      url: '/home/me/index.html',
      zoom: 2,
      reloadNonce: 3,
    });
  });

  it('ignores the record a previous browser left in the same pane', () => {
    // Closing a browser and opening another reuses the pane id, so the old
    // record is still there — describing a page this pane no longer shows.
    const stale = state({ source: '/home/me/old.html', zoom: 2, reloadNonce: 4 });
    expect(browserView(stale, lines)).toEqual({
      url: '/home/me/index.html',
      zoom: 1,
      reloadNonce: 0,
    });
  });
});

describe('clampZoom', () => {
  it('holds the zoom inside its bounds and off floating-point dust', () => {
    expect(clampZoom(1 + 0.1 + 0.1)).toBe(1.2);
    expect(clampZoom(MIN_ZOOM - 1)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM + 1)).toBe(MAX_ZOOM);
  });
});
