/**
 * Clicks a plugin's `[[link_handlers]]` may take (docs/PLUGINS.md).
 *
 * A link's click is announced as a `tmuxy:open-link` event (`openLinkFrom`);
 * a URL whose host an installed plugin declares is sent to the server
 * (`PLUGIN_OPEN_LINK`), which checks the whole URL and either opens the
 * plugin's action or answers that the browser should. Shift skips plugins.
 *
 * A Cmd/Ctrl+click on plain text, when an installed plugin has text
 * handlers, sends the clicked line and column (`PLUGIN_OPEN_TEXT`): the
 * patterns run on the server, in linear time, never as a regex here.
 */

import { useEffect } from 'react';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { isMacPlatform } from '../utils/platform';
import { LINK_EVENT, type LinkEventDetail } from '../utils/openUrl';
import { pluginLinkHosts } from '../domain/plugins';
import type { PaneId } from '../domain/ids';

/** The pane an element is drawn in. */
function paneOf(el: Element | null): PaneId | null {
  const pane = el?.closest('[data-pane-id]')?.getAttribute('data-pane-id');
  return pane && /^%\d+$/.test(pane) ? (pane as PaneId) : null;
}

/** The line a click landed on and the column in it, in characters. */
export function clickedText(e: MouseEvent): { line: string; column: number } | null {
  const target = e.target instanceof Element ? e.target : null;
  const lineEl = target?.closest('.terminal-line');
  if (!lineEl || target?.closest('a')) return null;
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const caret = doc.caretPositionFromPoint?.(e.clientX, e.clientY);
  const range = caret ? null : document.caretRangeFromPoint?.(e.clientX, e.clientY);
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset ?? 0;
  if (!node || !lineEl.contains(node)) return null;
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let column = 0;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text === node) {
      column += Array.from((text.textContent ?? '').slice(0, offset)).length;
      return { line: lineEl.textContent ?? '', column };
    }
    column += Array.from(text.textContent ?? '').length;
  }
  return null;
}

export function usePluginLinks(): void {
  const send = useAppSend();
  const plugins = useAppSelector((ctx) => ctx.plugins);

  useEffect(() => {
    const { hosts, text } = pluginLinkHosts(plugins);
    if (hosts.size === 0 && !text) return;
    const apple = isMacPlatform();

    const onLink = (e: Event) => {
      const { url, bypass } = (e as CustomEvent<LinkEventDetail>).detail;
      if (bypass) return;
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      const paneId = paneOf(e.target instanceof Element ? e.target : null);
      if (!paneId || !hosts.has(host)) return;
      e.preventDefault();
      send({ type: 'PLUGIN_OPEN_LINK', url, paneId });
    };

    const onClick = (e: MouseEvent) => {
      if (!(apple ? e.metaKey : e.ctrlKey) || e.shiftKey || e.button !== 0) return;
      const at = clickedText(e);
      const paneId = paneOf(e.target instanceof Element ? e.target : null);
      if (!at || !paneId) return;
      send({ type: 'PLUGIN_OPEN_TEXT', paneId, line: at.line, column: at.column });
    };

    document.addEventListener(LINK_EVENT, onLink);
    if (text) document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener(LINK_EVENT, onLink);
      document.removeEventListener('click', onClick, true);
    };
  }, [plugins, send]);
}
