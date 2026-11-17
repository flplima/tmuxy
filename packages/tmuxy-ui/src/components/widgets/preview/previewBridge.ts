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
 *   the app. A copy with something to copy stays the page's (`pageChord`);
 * - **open** — a link the user followed, handed to the system browser;
 * - **emit** — a value the page handed to `window.tmuxy.emit`, as one line of
 *   JSON, which the app types into the preview's own pane (`{"emit":…}`).
 *
 * The page is not trusted, and anything can post a message, so the app reads
 * each one through `readBridgeMessage` and acts on a key only when it is
 * plausible the user pressed it (see `HtmlPreview`).
 */

import { asciiJson } from '../../../domain/commandHelpers';

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
  | { type: 'open'; url: string }
  | { type: 'emit'; json: string };

/** The longest line a `tmuxy.emit` value may travel as, in bytes (ASCII). */
export const EMIT_MAX_BYTES = 16 * 1024;

/** How often a page may emit: a burst, then so many a second; the rest are dropped. */
export const EMIT_RATE = { burst: 20, perSecond: 10 } as const;

/**
 * The line `value` travels as: its JSON, every character outside printable
 * ASCII escaped (`ascii`, `asciiJson`), at most `maxBytes` long. Throws a
 * `TypeError` for a value JSON cannot hold (`undefined`, a function, a cycle,
 * a BigInt) and a `RangeError` for one too long.
 *
 * The bridge runs it in the page, so a page learns at once that an emit was
 * refused; the app runs it again on what arrives, since the page's realm is
 * the page's to tamper with. In the page it is handed to `bridge` by
 * `bridgeScript`, so it may use nothing outside itself.
 */
export function emitLine(
  value: unknown,
  stringify: (value: unknown) => string | undefined,
  ascii: (json: string) => string,
  maxBytes: number,
): string {
  let json: string | undefined;
  try {
    json = stringify(value);
  } catch {
    json = undefined;
  }
  if (typeof json !== 'string') {
    throw new TypeError('tmuxy.emit: the value cannot be written as JSON');
  }
  const line = ascii(json);
  if (line.length > maxBytes) {
    throw new RangeError(`tmuxy.emit: the value is over ${maxBytes} bytes as JSON`);
  }
  return line;
}

/**
 * A budget of `burst` emits, refilled at `perSecond`: each call takes one,
 * true, or finds none left, false. Also run in the page, by the bridge.
 */
export function emitBudget(burst: number, perSecond: number, now: () => number): () => boolean {
  let tokens = burst;
  let last = now();
  return () => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
    last = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** What the bridge runs in the page besides itself, each standalone. */
interface PageHelpers {
  chordOf: typeof pageChord;
  lineOf: typeof emitLine;
  ascii: typeof asciiJson;
  budgetOf: typeof emitBudget;
  emitIn: typeof installEmit;
}

/** How long and how often an emit may be: `EMIT_MAX_BYTES`, `EMIT_RATE`. */
interface EmitLimits {
  maxBytes: number;
  burst: number;
  perSecond: number;
}

/**
 * `window.tmuxy.emit(value)` in the page: true once handed to the app (by
 * `post`), false when the page emits faster than the app takes (dropped, not
 * queued); throws for a value that is not JSON, or too long. The global is
 * replaceable, like any the page may want for itself: the bridge keeps its
 * own copy. Run by the bridge before the page's scripts, so what it takes
 * (`JSON.stringify`, the clock) is the browser's; standalone.
 */
function installEmit(
  post: (message: unknown) => void,
  limits: EmitLimits,
  helpers: Pick<PageHelpers, 'lineOf' | 'ascii' | 'budgetOf'>,
): void {
  const { lineOf, ascii, budgetOf } = helpers;
  const stringify = JSON.stringify.bind(JSON);
  const take = budgetOf(limits.burst, limits.perSecond, performance.now.bind(performance));
  const emit = (value: unknown) => {
    const json = lineOf(value, stringify, ascii, limits.maxBytes);
    if (!take()) return false;
    post({ type: 'emit', json });
    return true;
  };
  Object.defineProperty(window, 'tmuxy', {
    value: Object.freeze({ emit }),
    configurable: true,
    writable: true,
  });
}

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

/**
 * What the bridge does with a Ctrl or Alt chord pressed in the page, given
 * whether the page has something to copy (selected text, or the cursor in a
 * field): `native` leaves the browser's own copy (Ctrl+C) to the browser,
 * `copy` copies for the terminal's (Ctrl+Shift+C), which the browser does not
 * know, and `post` hands the chord to the app. With nothing to copy, Ctrl+C
 * is the app's, and quits the preview.
 *
 * It runs inside the page, handed to `bridge` by `bridgeScript`, so it may
 * use nothing outside itself.
 */
export function pageChord(
  key: { key: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  somethingToCopy: boolean,
): 'native' | 'copy' | 'post' {
  if (!somethingToCopy || !key.ctrlKey || key.altKey || key.key.toLowerCase() !== 'c') {
    return 'post';
  }
  return key.shiftKey ? 'copy' : 'native';
}

/** The script's body: a function of where to scroll to once the page loads. */
function bridge(
  start: { x: number; y: number },
  channel: BridgeChannel,
  limits: EmitLimits,
  helpers: PageHelpers,
) {
  // Remove our own <script> element and take what we call before any page
  // script runs, so the page can neither read the token from the DOM nor
  // replace the functions we post and listen with. `isTrusted` needs no
  // capture: it is an unforgeable own property of every event.
  document.currentScript?.remove();
  const { chordOf, emitIn } = helpers;
  const { token, targetOrigin } = channel;
  const postToParent = parent.postMessage.bind(parent);
  const addWin = window.addEventListener.bind(window);
  const addDoc = document.addEventListener.bind(document);
  const selection = window.getSelection.bind(window);
  const execCommand = document.execCommand.bind(document);
  const inField = (target: EventTarget | null) =>
    !!(target as Element | null)?.closest?.(
      'input, textarea, [contenteditable]:not([contenteditable="false"])',
    );
  const post = (message: unknown) => postToParent({ tmuxyPreview: message, token }, targetOrigin);
  emitIn(post, limits, helpers);
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
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      const chord = chordOf(e, inField(e.target) || selection()?.isCollapsed === false);
      e.preventDefault();
      e.stopImmediatePropagation();
      if (chord === 'native' || chord === 'copy') {
        execCommand('copy');
        return;
      }
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
  const limits = { maxBytes: EMIT_MAX_BYTES, ...EMIT_RATE };
  const helpers = `{chordOf:${pageChord.toString()},lineOf:${emitLine.toString()},ascii:${asciiJson.toString()},budgetOf:${emitBudget.toString()},emitIn:${installEmit.toString()}}`;
  return `(${bridge.toString()})(${JSON.stringify(start)},${JSON.stringify(channel)},${JSON.stringify(limits)},${helpers});`;
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
      if (!ctrlKey && !altKey) return null;
      if (MODIFIERS.has(key)) return null;
      // Ctrl/Cmd+Enter answers the questions waiting in the tab; a page
      // never gets to press it on the user's behalf.
      if (key === 'Enter') return null;
      return { type: 'key', key, code, ctrlKey, altKey, shiftKey: shiftKey === true };
    }
    case 'open':
      return short(message.url, 4096) ? { type: 'open', url: message.url } : null;
    case 'emit':
      return readEmit(message.json);
    default:
      return null;
  }
}

/**
 * An emit's line as the app will type it, or null: what arrives must parse as
 * JSON, and is written out again here — one line of printable ASCII, within
 * the limit — whatever the page's realm did to the bridge's copy.
 */
function readEmit(json: unknown): BridgeMessage | null {
  if (!short(json, EMIT_MAX_BYTES)) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  try {
    return { type: 'emit', json: emitLine(value, JSON.stringify, asciiJson, EMIT_MAX_BYTES) };
  } catch {
    return null;
  }
}
