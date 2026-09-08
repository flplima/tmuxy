/**
 * What the browser widget was pointed at, and how to show it.
 *
 * `tmuxy widget browser <src>` resolves its argument to an absolute path or a
 * URL and streams it through the pane as `__SRC__:<value>`; everything the
 * widget knows about what it is showing is derived from that one string.
 */

import { fileUrl } from '../../../utils/fileUrl';

/** How the current source is rendered. */
export type SourceKind = 'image' | 'markdown' | 'page';

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;
const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/i;

const SRC_MARKER = '__SRC__:';

/**
 * Read the source out of the pane's widget content.
 *
 * tmux hard-wraps a long URL across several cell lines with no separator, so
 * the lines are joined before the marker is stripped — the same reassembly the
 * image widget needed.
 */
export function parseSource(lines: string[]): string {
  const joined = lines.join('').trim();
  const at = joined.indexOf(SRC_MARKER);
  if (at === -1) return '';
  return joined.slice(at + SRC_MARKER.length).trim();
}

export function classifySource(src: string): SourceKind {
  if (src.startsWith('data:image/')) return 'image';
  // The extension is the one the *path* ends in. A query string can carry
  // anything — `?file=a.png` names a download, not the page being viewed.
  const path = src.split(/[?#]/)[0];
  if (MARKDOWN_EXTENSIONS.test(path)) return 'markdown';
  if (IMAGE_EXTENSIONS.test(path)) return 'image';
  return 'page';
}

/** True for sources the webview can load as-is, without going through a file route. */
function isRemote(src: string): boolean {
  return /^(?:https?:|data:|blob:)/i.test(src);
}

/**
 * The URL to actually load for a source: remote ones as written, local paths
 * through whichever file route this build has (see utils/fileUrl).
 *
 * `reloadNonce` is appended once the user has asked for a refresh at least
 * once — remounting the element is not enough on its own to get past an
 * already-cached response.
 */
export function loadUrl(src: string, reloadNonce = 0): string {
  const base = isRemote(src) ? src : fileUrl(src.replace(/^file:\/\//, ''));
  if (reloadNonce <= 0) return base;
  return `${base}${base.includes('?') ? '&' : '?'}_tmuxyReload=${reloadNonce}`;
}

/**
 * The pane's tab title: the file path, or the URL with its protocol stripped.
 * A lone trailing slash goes too, so a bare host reads as `localhost:3000`.
 */
export function browserTitle(src: string): string {
  if (!src) return 'browser';
  if (src.startsWith('data:')) {
    const [meta] = src.split(',', 1);
    return `${meta.slice(0, 32)}…`;
  }
  const stripped = src.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const trimmed = stripped.length > 1 ? stripped.replace(/\/$/, '') : stripped;
  return trimmed || src;
}
