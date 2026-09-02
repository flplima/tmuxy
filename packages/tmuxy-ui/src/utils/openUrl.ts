/**
 * Open a link a pane printed (OSC 8 hyperlink or auto-detected URL).
 *
 * In a browser the anchor could do this itself, but the desktop webview never
 * opens `target="_blank"` anchors (a new-window request is denied), so a click
 * on a link did nothing there. Both builds therefore route through here: the
 * desktop asks its Rust side to hand the URL to the system browser, the web
 * build opens a new tab. Only http(s)/mailto links are ever opened — a pane can
 * print any text.
 */

import { isTauri } from '../tmux/adapters';

const OPENABLE = /^(https?:\/\/|mailto:)/i;

export function isOpenableUrl(url: string): boolean {
  return OPENABLE.test(url.trim());
}

export function openExternalUrl(url: string): void {
  if (!isOpenableUrl(url)) return;
  if (isTauri()) {
    void import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke('open_url', { url }).catch((e: unknown) => console.error('open_url failed:', e)),
    );
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
