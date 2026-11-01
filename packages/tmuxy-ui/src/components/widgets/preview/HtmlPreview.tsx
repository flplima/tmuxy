/**
 * A local page, in a sandboxed frame.
 *
 * The page is composed (`composePage`), staged with the backend, and loaded
 * from the URL that serves it under its own policy (`stagePreview`). The frame
 * is `sandbox="allow-scripts"` and nothing more: the page runs in an opaque
 * origin, cannot open windows, submit forms or navigate the app, and reaches
 * the app only through the bridge's messages (`previewBridge.ts`).
 *
 * Each composition is a new URL, so the frame loads it afresh — at the scroll
 * position the bridge last reported, so a change to the file redraws the page
 * where the reader was.
 */

import { useEffect, useRef, useState } from 'react';
import { composePage } from './previewPage';
import {
  markReplayedPreviewKey,
  newBridgeChannel,
  readBridgeMessage,
  type BridgeMessage,
} from './previewBridge';
import { useKeyedRequest } from './useKeyedRequest';
import type { PreviewSource } from './previewSource';
import type { PreviewTheme } from './previewTheme';
import type { PreviewDocument } from '../../../domain/preview';
import { openExternalUrl, safeHref } from '../../../utils/openUrl';

/** A link the page followed, opened in the system browser when it leaves tmuxy. */
function openLink(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  // A relative link resolves against the page's own URL, which is tmuxy's: it
  // names another local file, which a preview does not open.
  if (parsed.origin === window.location.origin) return;
  const safe = safeHref(parsed.href);
  if (safe) openExternalUrl(safe);
}

/**
 * A chord pressed in the page, replayed to the app as if pressed outside it.
 *
 * Only while the user is in this page: a page that posts keys on its own has
 * no focus to post them from. And then the keyboard moves to the pane, so the
 * next key the user types reaches the app directly — the second key of a
 * prefix binding, say — and the page cannot follow one replayed key with
 * another. The key is dispatched on the pane, where the keyboard now is, so
 * it travels the path a real one does: the window's capture listeners, down
 * to the pane, and back up to the keyboard actor's.
 */
function replayKey(frame: HTMLIFrameElement, key: Extract<BridgeMessage, { type: 'key' }>) {
  if (document.activeElement !== frame) return;
  const pane = frame.closest<HTMLElement>('.pane-wrapper');
  if (!pane) return;
  pane.focus({ preventScroll: true });
  pane.dispatchEvent(
    markReplayedPreviewKey(
      new KeyboardEvent('keydown', {
        key: key.key,
        code: key.code,
        ctrlKey: key.ctrlKey,
        altKey: key.altKey,
        shiftKey: key.shiftKey,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}

/** A stable key per object, for asking again when a new document arrives. */
const keys = new WeakMap<object, number>();
let nextKey = 0;
function keyOf(value: object): number {
  let key = keys.get(value);
  if (key === undefined) {
    key = ++nextKey;
    keys.set(value, key);
  }
  return key;
}

export function HtmlPreview({
  doc,
  theme,
  source,
}: {
  doc: PreviewDocument;
  /** Null when opened with `--no-theme`. */
  theme: PreviewTheme | null;
  source: PreviewSource;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef({ x: 0, y: 0 });
  const tokenRef = useRef<string | null>(null);
  const [title, setTitle] = useState('');
  const page = useKeyedRequest(`${keyOf(doc)}:${theme ? keyOf(theme) : 0}`, async () => {
    const channel = newBridgeChannel();
    const url = await source.stagePage(
      await composePage(doc.text, source.readResource, {
        theme,
        scroll: scrollRef.current,
        channel,
      }),
    );
    return { url, token: channel.token };
  });
  tokenRef.current = page.value?.token ?? null;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      const expectedToken = tokenRef.current;
      if (!frame?.contentWindow || e.source !== frame.contentWindow || !expectedToken) return;
      const message = readBridgeMessage(e.data, expectedToken);
      if (!message) return;
      switch (message.type) {
        case 'scroll':
          scrollRef.current = { x: message.x, y: message.y };
          frame.dataset.scrollY = String(Math.round(message.y));
          return;
        case 'title':
          setTitle(message.title);
          return;
        case 'open':
          openLink(message.url);
          return;
        case 'key':
          replayKey(frame, message);
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!page.value) {
    return <div className="preview-message">{page.error ?? 'Composing the page…'}</div>;
  }
  return (
    <iframe
      ref={frameRef}
      className="preview-frame"
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      title={title || doc.name}
      src={page.value.url}
    />
  );
}
