/**
 * Reading the `<title>` of the page a browser pane is showing.
 *
 * The frame cannot be asked: a local page runs in an opaque origin (no
 * `allow-same-origin`, see TmuxyBrowser) and a website is another origin
 * outright, so `contentDocument` is null either way — by design, and not
 * something to work around. What CAN be read is the HTML itself, where the app
 * is allowed to fetch it: a local file goes through tmuxy's own file route,
 * and a same-origin page is the app's own server. Anything else is left
 * alone — not merely because the request would fail, but because firing one
 * that is certain to fail logs a CORS error per page and gains nothing.
 *
 * So a pane showing a local file or one of tmuxy's own pages is named after
 * the page; a pane showing github.com is named after the address. That is the
 * honest split, and it is the common case: the app is pointed at local files
 * far more often than at sites.
 */

import { isRemote } from './source';

/** How much of the document to read: `<title>` lives in the head. */
const HEAD_BYTES = 64 * 1024;

/**
 * Whether the app may read this page's HTML at all.
 *
 * A non-remote source is a path, which the file route serves from the app's
 * own origin. A remote one has to BE the app's origin — anything else is a
 * cross-origin read the browser will refuse.
 */
export function canReadPageTitle(src: string, loadUrl: string): boolean {
  if (!isRemote(src)) return true;
  if (typeof window === 'undefined') return false;
  try {
    return new URL(loadUrl, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * The `<title>` in a chunk of HTML, collapsed to one line.
 *
 * Parsed with the platform's own parser rather than a regex: a title may hold
 * entities (`Tmuxy &mdash; docs`) and a regex would hand back the source text
 * of those. `DOMParser` on a partial document is fine — the head is complete
 * long before the body is.
 */
export function parseHtmlTitle(html: string): string {
  if (!html.includes('<title')) return '';
  try {
    const title = new DOMParser().parseFromString(html, 'text/html').title;
    return title.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Fetch just enough of a page to read its title.
 *
 * Returns '' for anything unreadable — a failed request, a page with no
 * title, a document that is not HTML. The caller falls back to the address,
 * which is always something.
 */
export async function fetchPageTitle(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) return '';
    const type = response.headers.get('content-type') ?? '';
    // `text/html` or nothing at all (the desktop's file scheme names no type
    // for an .html file); a stylesheet or a PDF has no title to find.
    if (type && !/^text\/html|^application\/xhtml/i.test(type)) return '';

    // The head, not the whole document: a page can be megabytes, and the
    // title is in the first few kilobytes of every one of them.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    try {
      while (html.length < HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        if (html.includes('</title>')) break;
      }
    } finally {
      // Whatever we did or did not read, the rest of the response is not
      // wanted — an un-cancelled stream holds the connection open.
      await reader.cancel().catch(() => {});
    }
    return parseHtmlTitle(html);
  } catch {
    return '';
  }
}
