/**
 * The one channel between a framed page and the app.
 *
 * A page runs in a sandboxed frame with an opaque origin: it cannot reach the
 * app's DOM, storage or API, and the app cannot reach into it. What the
 * preview still needs across that line travels as `postMessage`, sent by a
 * small script put at the top of the page (`bridgeScript`):
 *
 * - **scroll** — where the page is scrolled to, so the page drawn again after
 *   the file changes opens at the same place;
 * - **title** — the page's `<title>`, for the frame's accessible name;
 * - **key** — a Ctrl or Alt chord pressed in the page. The page has the
 *   keyboard while the user is in it, so without this Ctrl+C would never
 *   reach the widget (it quits the preview) and the prefix would never reach
 *   the app;
 * - **open** — a link the user followed, handed to the system browser.
 *
 * The page is not trusted, and anything can post a message, so the app reads
 * each one through `readBridgeMessage` and acts on a key only when it is
 * plausible the user pressed it (see `HtmlPreview`).
 */

export type BridgeMessage =
  | { type: 'scroll'; x: number; y: number }
  | { type: 'title'; title: string }
  | {
      type: 'key';
      key: string;
      code: string;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }
  | { type: 'open'; url: string };

/**
 * What one composed page's bridge signs its messages with, and where it sends
 * them.
 *
 * `token` is fresh per composition, so a page's own scripts (which run after
 * the bridge has removed its `<script>`) cannot sign a message of their own.
 * `targetOrigin` is the app's origin: a page opened with `--net` may frame
 * its own URL, and the bridge in that inner copy posts to its parent — the
 * outer page — so it is told to deliver only to the app, never to the page
 * (whose sandboxed origin is opaque). It is `*` only where the app's origin
 * is not an http(s) one (the desktop app's own scheme), which a page's
 * `frame-src` cannot name, so no inner copy can be framed there.
 */
export interface BridgeChannel {
  token: string;
  targetOrigin: string;
}

export function newBridgeChannel(): BridgeChannel {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const { protocol, origin } = window.location;
  const targetOrigin = protocol === 'http:' || protocol === 'https:' ? origin : '*';
  return { token, targetOrigin };
}

const replayedPreviewKeys = new WeakSet<KeyboardEvent>();

/** Tag a synthetic KeyboardEvent replayed out of an `HtmlPreview` frame. */
export function markReplayedPreviewKey<T extends KeyboardEvent>(event: T): T {
  replayedPreviewKeys.add(event);
  return event;
}

/** True when `event` was synthesized by `HtmlPreview` rather than pressed in the app. */
export function isReplayedPreviewKey(event: KeyboardEvent): boolean {
  return replayedPreviewKeys.has(event);
}

/** The script's body: a function of where to scroll to once the page loads. */
function bridge(start: { x: number; y: number }, channel: BridgeChannel) {
  // Remove our own <script> element and take what we call before any page
  // script runs, so the page can neither read the token from the DOM nor
  // replace the functions we post and listen with. `isTrusted` needs no
  // capture: it is an unforgeable own property of every event.
  document.currentScript?.remove();
  const { token, targetOrigin } = channel;
  const postToParent = parent.postMessage.bind(parent);
  const addWin = window.addEventListener.bind(window);
  const addDoc = document.addEventListener.bind(document);
  const post = (message: unknown) => postToParent({ tmuxyPreview: message, token }, targetOrigin);
  const restore = () => window.scrollTo(start.x, start.y);
  addDoc('DOMContentLoaded', restore);
  addWin('load', () => {
    restore();
    post({ type: 'title', title: document.title });
  });
  let pending = false;
  addWin(
    'scroll',
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        post({ type: 'scroll', x: window.scrollX, y: window.scrollY });
      });
    },
    { passive: true },
  );
  addWin(
    'keydown',
    (e) => {
      if (!e.isTrusted) return;
      if (!(e.ctrlKey || e.altKey) || e.metaKey) return;
      // Ctrl held on its own is the start of a chord, not one.
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post({
        type: 'key',
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      });
    },
    true,
  );
  addDoc(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      const target = e.target as Element | null;
      const link = target?.closest ? target.closest('a[href]') : null;
      if (!link || (link.getAttribute('href') ?? '').startsWith('#')) return;
      e.preventDefault();
      post({ type: 'open', url: (link as HTMLAnchorElement).href });
    },
    true,
  );
}

/** The `<script>` that runs `bridge`, first in the page, scrolled to `start`. */
export function bridgeScript(start: { x: number; y: number }, channel: BridgeChannel): string {
  return `(${bridge.toString()})(${JSON.stringify(start)},${JSON.stringify(channel)});`;
}

const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** A message the page's bridge signed with `token`, if it is one; null otherwise. */
export function readBridgeMessage(data: unknown, token: string): BridgeMessage | null {
  if (typeof data !== 'object' || data === null || !('tmuxyPreview' in data)) return null;
  if ((data as { token?: unknown }).token !== token) return null;
  const m = (data as { tmuxyPreview: unknown }).tmuxyPreview;
  if (typeof m !== 'object' || m === null) return null;
  const message = m as Record<string, unknown>;
  switch (message.type) {
    case 'scroll':
      return isFiniteNumber(message.x) && isFiniteNumber(message.y)
        ? { type: 'scroll', x: message.x, y: message.y }
        : null;
    case 'title':
      return short(message.title, 300) ? { type: 'title', title: message.title } : null;
    case 'key': {
      const { key, code, ctrlKey, altKey, shiftKey } = message;
      if (!short(key, 24) || !short(code, 32)) return null;
      if (typeof ctrlKey !== 'boolean' || typeof altKey !== 'boolean') return null;
      // Only a chord crosses: a plain key stays the page's, and a modifier
      // on its own is not one.
      if (!ctrlKey && !altKey) return null;
      if (MODIFIERS.has(key)) return null;
      // Ctrl/Cmd+Enter answers the questions waiting in the tab; a page
      // never gets to press it on the user's behalf.
      if (key === 'Enter') return null;
      return { type: 'key', key, code, ctrlKey, altKey, shiftKey: shiftKey === true };
    }
    case 'open':
      return short(message.url, 4096) ? { type: 'open', url: message.url } : null;
    default:
      return null;
  }
}
