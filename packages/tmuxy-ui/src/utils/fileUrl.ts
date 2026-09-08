/**
 * Resolve a URL the webview can load for a file on the machine tmux runs on.
 *
 * On the web that is the server's `/api/browse/<path>` route. The desktop app
 * serves no HTTP at all, so it hands the same bytes out through its own
 * `tmuxyfile:` scheme (registered in `tmuxy-tauri-app/src/gui.rs`) — the same
 * split the inline-image resolver in `Terminal.tsx` makes.
 *
 * Both forms put the path IN the URL path rather than in a query string, so a
 * framed page's relative links (`./style.css`) resolve to the file next to it.
 *
 * Tests and Storybook stories can override the resolver by setting
 * `window.__tmuxyFileSrc` — useful for serving data:/blob: URLs without
 * standing up a backend.
 */

import { isTauri } from '../tmux/adapters';

/** Percent-encode a path for use as URL path segments, keeping the separators. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function fileUrl(absPath: string): string {
  if (typeof window !== 'undefined') {
    const override = (
      window as unknown as { __tmuxyFileSrc?: (path: string) => string | undefined }
    ).__tmuxyFileSrc;
    if (override) {
      const resolved = override(absPath);
      if (resolved) return resolved;
    }
    if (isTauri()) {
      // Windows serves custom schemes over http://<scheme>.localhost; the
      // platforms tmuxy ships a desktop build for use the scheme directly.
      const base = navigator.userAgent.includes('Windows')
        ? 'http://tmuxyfile.localhost'
        : 'tmuxyfile://localhost';
      return `${base}${encodePath(absPath)}`;
    }
  }
  return `/api/browse${encodePath(absPath)}`;
}

/**
 * The inverse of `fileUrl` for the two path-shaped forms, so a page that
 * navigated inside its iframe can be reported back as the plain path the user
 * typed. Anything else (an http(s) site, a data: URI) is returned unchanged.
 */
export function pathFromFileUrl(url: string): string {
  const patterns = [
    /^https?:\/\/[^/]*\/api\/browse(\/.*)$/,
    /^\/api\/browse(\/.*)$/,
    /^tmuxyfile:\/\/[^/]*(\/.*)$/,
    /^http:\/\/tmuxyfile\.localhost(\/.*)$/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(url);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return url;
}
