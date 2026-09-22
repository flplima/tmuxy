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
import { browserView, clampZoom, normalizeAddress, MAX_ZOOM, MIN_ZOOM } from '../view';
import type { BrowserPaneState } from '../../../../machines/types';
import { canReadPageTitle, parseHtmlTitle } from '../pageTitle';

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
    history: ['/home/me/index.html'],
    historyIndex: 0,
    ...over,
  });

  it('shows the pane marker source at zoom 1 before the user does anything', () => {
    expect(browserView(undefined, lines)).toEqual({
      url: '/home/me/index.html',
      source: '/home/me/index.html',
      zoom: 1,
      reloadNonce: 0,
      canGoBack: false,
      canGoForward: false,
      pageTitle: '',
    });
  });

  it("applies this browser's zoom and refreshes", () => {
    expect(browserView(state({ zoom: 2, reloadNonce: 3 }), lines)).toEqual({
      url: '/home/me/index.html',
      source: '/home/me/index.html',
      zoom: 2,
      reloadNonce: 3,
      canGoBack: false,
      canGoForward: false,
      pageTitle: '',
    });
  });

  it('shows where the pane has been navigated, and what it can step to', () => {
    // The source stays the record's identity — it is what the pane's marker
    // declares — while `url` is the page actually on screen.
    const browsed = state({
      history: ['/home/me/index.html', 'https://example.com', 'https://example.com/docs'],
      historyIndex: 1,
    });
    expect(browserView(browsed, lines)).toEqual({
      url: 'https://example.com',
      source: '/home/me/index.html',
      zoom: 1,
      reloadNonce: 0,
      canGoBack: true,
      canGoForward: true,
      pageTitle: '',
    });
  });

  it("carries the page's own title, and only for the page it belongs to", () => {
    // The pane's tab is how panes are told apart, so a title left over from
    // the page before would be worse than showing the address.
    const titled = state({ pageTitle: { url: '/home/me/index.html', title: 'Release notes' } });
    expect(browserView(titled, lines).pageTitle).toBe('Release notes');

    const moved = state({
      history: ['/home/me/index.html', 'https://example.com'],
      historyIndex: 1,
      pageTitle: { url: '/home/me/index.html', title: 'Release notes' },
    });
    expect(browserView(moved, lines).pageTitle).toBe('');
  });

  it('has nowhere to go from the only entry there is', () => {
    const view = browserView(state(), lines);
    expect(view.canGoBack).toBe(false);
    expect(view.canGoForward).toBe(false);
  });

  it('ignores the record a previous browser left in the same pane', () => {
    // Closing a browser and opening another reuses the pane id, so the old
    // record is still there — describing a page this pane no longer shows.
    const stale = state({
      source: '/home/me/old.html',
      zoom: 2,
      reloadNonce: 4,
      history: ['/home/me/old.html', 'https://example.com'],
      historyIndex: 1,
    });
    expect(browserView(stale, lines)).toEqual({
      url: '/home/me/index.html',
      source: '/home/me/index.html',
      zoom: 1,
      reloadNonce: 0,
      canGoBack: false,
      canGoForward: false,
      pageTitle: '',
    });
  });
});

describe('normalizeAddress', () => {
  it('gives a bare host the scheme the user meant', () => {
    expect(normalizeAddress('example.com')).toBe('https://example.com');
    expect(normalizeAddress('example.com/docs?q=1')).toBe('https://example.com/docs?q=1');
  });

  it('reads host:port as a host and a port, not as a scheme', () => {
    // `localhost:3000` matches the scheme shape exactly — and a loopback host
    // gets http, because a dev server on 3000 is almost never serving TLS and
    // an iframe cannot fall back from a failed https the way a browser does.
    expect(normalizeAddress(' localhost:3000 ')).toBe('http://localhost:3000');
    expect(normalizeAddress('127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health');
    expect(normalizeAddress('tmuxy.localhost')).toBe('http://tmuxy.localhost');
    expect(normalizeAddress('example.com:8443')).toBe('https://example.com:8443');
  });

  it('leaves an address that already says what it is alone', () => {
    // The widget shows local files too — rewriting a path into a URL here
    // would break the case the app is most often pointed at.
    expect(normalizeAddress('http://localhost:9000')).toBe('http://localhost:9000');
    expect(normalizeAddress('file:///home/me/a.html')).toBe('file:///home/me/a.html');
    expect(normalizeAddress('/home/me/notes.md')).toBe('/home/me/notes.md');
    expect(normalizeAddress('~/notes.md')).toBe('~/notes.md');
    expect(normalizeAddress('./rel.html')).toBe('./rel.html');
    expect(normalizeAddress('data:text/html,<b>hi</b>')).toBe('data:text/html,<b>hi</b>');
  });

  it('reads an empty address as "do nothing"', () => {
    expect(normalizeAddress('   ')).toBe('');
    expect(normalizeAddress('')).toBe('');
  });
});

describe('clampZoom', () => {
  it('holds the zoom inside its bounds and off floating-point dust', () => {
    expect(clampZoom(1 + 0.1 + 0.1)).toBe(1.2);
    expect(clampZoom(MIN_ZOOM - 1)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM + 1)).toBe(MAX_ZOOM);
  });
});

describe('parseHtmlTitle', () => {
  it('reads the title out of a head, entities and all', () => {
    // A regex would hand back `&mdash;` as written; the platform's parser is
    // what turns it into the character the page actually shows.
    expect(parseHtmlTitle('<html><head><title>Tmuxy &mdash; docs</title></head>')).toBe(
      'Tmuxy — docs',
    );
  });

  it('collapses a title broken across lines into one', () => {
    expect(parseHtmlTitle('<title>\n  Release\n  notes\n</title>')).toBe('Release notes');
  });

  it('finds nothing where there is nothing to find', () => {
    expect(parseHtmlTitle('<html><body>no head</body></html>')).toBe('');
    expect(parseHtmlTitle('')).toBe('');
    expect(parseHtmlTitle('not html at all')).toBe('');
  });
});

describe('canReadPageTitle', () => {
  it("reads a local file — it comes through the app's own route", () => {
    expect(canReadPageTitle('/home/me/index.html', '/api/browse/home/me/index.html')).toBe(true);
  });

  it('reads a page served by the app itself', () => {
    expect(
      canReadPageTitle(`${window.location.origin}/docs`, `${window.location.origin}/docs`),
    ).toBe(true);
  });

  it('leaves a cross-origin site alone', () => {
    // Not merely because the request would fail: firing one that is certain
    // to fail logs a CORS error for every page and gains nothing.
    expect(canReadPageTitle('https://example.com/docs', 'https://example.com/docs')).toBe(false);
  });
});
