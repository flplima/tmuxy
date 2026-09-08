/**
 * The browser widget's pure halves: reading its source out of pane content,
 * deciding how to show it, and deriving history/zoom from machine state.
 *
 * These are the pieces the rendered widget, the pane title and the ⋮ menu all
 * agree through — a disagreement here is a pane whose tab names one page while
 * the frame shows another.
 */

import { describe, it, expect } from 'vitest';
import { browserTitle, classifySource, loadUrl, parseSource } from '../source';
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
    pushed: [],
    index: 0,
    zoom: 1,
    reloadNonce: 0,
    ...over,
  });

  it('shows the pane marker source with nowhere to go, before any navigation', () => {
    const view = browserView(undefined, lines);
    expect(view.url).toBe('/home/me/index.html');
    expect(view.zoom).toBe(1);
    expect(view.canGoBack).toBe(false);
    expect(view.canGoForward).toBe(false);
  });

  it('treats the marker source as history entry 0, ahead of what was pushed', () => {
    const view = browserView(state({ pushed: ['/home/me/next.html'], index: 1 }), lines);
    expect(view.entries).toEqual(['/home/me/index.html', '/home/me/next.html']);
    expect(view.url).toBe('/home/me/next.html');
    expect(view.canGoBack).toBe(true);
    expect(view.canGoForward).toBe(false);
  });

  it('goes back to the opening page from a pushed one', () => {
    const view = browserView(state({ pushed: ['/home/me/next.html'], index: 0 }), lines);
    expect(view.url).toBe('/home/me/index.html');
    expect(view.canGoBack).toBe(false);
    expect(view.canGoForward).toBe(true);
  });

  it('survives a cursor left past the end of a shortened history', () => {
    const view = browserView(state({ pushed: [], index: 3 }), lines);
    expect(view.url).toBe('/home/me/index.html');
    expect(view.index).toBe(0);
  });

  it('ignores the record a previous browser left in the same pane', () => {
    // Closing a browser and opening another reuses the pane id, so the old
    // record is still there — with a cursor into a history that no longer
    // describes what this pane is showing.
    const stale = state({
      source: '/home/me/old.html',
      pushed: ['/home/me/old-next.html'],
      index: 1,
      zoom: 2,
      reloadNonce: 4,
    });
    const view = browserView(stale, lines);
    expect(view.url).toBe('/home/me/index.html');
    expect(view.entries).toEqual(['/home/me/index.html']);
    expect(view.zoom).toBe(1);
    expect(view.reloadNonce).toBe(0);
    expect(view.canGoBack).toBe(false);
  });
});

describe('clampZoom', () => {
  it('holds the zoom inside its bounds and off floating-point dust', () => {
    expect(clampZoom(1 + 0.1 + 0.1)).toBe(1.2);
    expect(clampZoom(MIN_ZOOM - 1)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM + 1)).toBe(MAX_ZOOM);
  });
});
