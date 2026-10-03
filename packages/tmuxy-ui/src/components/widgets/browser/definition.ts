/**
 * The `browser` widget's contributions to the pane chrome it does not own:
 * the tab icon and title, its section of the ⋮ pane menu, and the keys it
 * claims. See `../index.ts` for the WidgetDefinition contract.
 */

import type { WidgetDefinition, WidgetMenuItem } from '../index';
import { TmuxyBrowser } from './TmuxyBrowser';
import { selectBrowserView, ZOOM_STEP } from './view';
import { browserTitle, parseSource } from './source';
import { tmuxyOwnsKey } from '../../../machines/actors/keyboardActor';

/**  nf-fa-globe — a browser pane reads as a globe rather than a shell. */
const GLOBE_ICON = '\uf0ac';

export const browserWidget: WidgetDefinition = {
  component: TmuxyBrowser,
  icon: GLOBE_ICON,

  // The page's own `<title>` where it could be read, the address otherwise —
  // the same order of preference a browser tab uses. See `BROWSER_PAGE_TITLE`
  // for why a cross-origin site has no title to offer.
  selectTitle: (context, paneId, lines) => {
    const view = selectBrowserView(context, paneId, lines);
    return view.pageTitle || browserTitle(view.url);
  },

  selectMenuItems: (context, paneId, lines): WidgetMenuItem[] => {
    const view = selectBrowserView(context, paneId, lines);
    const source = view.url;
    return [
      {
        id: 'browser-zoom-in',
        label: 'Zoom In',
        event: { type: 'BROWSER_ZOOM', paneId, source, delta: ZOOM_STEP },
      },
      {
        id: 'browser-zoom-out',
        label: 'Zoom Out',
        event: { type: 'BROWSER_ZOOM', paneId, source, delta: -ZOOM_STEP },
      },
      {
        id: 'browser-copy-url',
        label: 'Copy Current URL',
        event: { type: 'BROWSER_COPY_URL', url: view.url },
      },
      {
        id: 'browser-refresh',
        label: 'Refresh',
        keyHint: 'ctrl+r',
        event: { type: 'BROWSER_RELOAD', paneId, source },
      },
      {
        id: 'browser-close',
        label: 'Close Browser',
        keyHint: 'ctrl+c',
        // The same SIGINT the generic widget ctrl+c sends: it ends the
        // `tmuxy widget browser` process, whose EXIT trap clears the marker
        // and hands the pane back to a shell.
        event: { type: 'SEND_KEYS', paneId, keys: 'C-c' },
      },
    ];
  },

  onKeyDown: (event, { paneId, instance, lines, context, send }) => {
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'r') {
      send({ type: 'BROWSER_RELOAD', paneId, source: parseSource(lines) });
      return true;
    }

    // A pane showing a SERVER-SIDE session forwards what is left to the page.
    //
    // This handler runs capture-phase, ahead of the keyboard actor, so
    // forwarding everything would swallow the tmux prefix and leave the pane
    // impossible to leave. `tmuxyOwnsKey` is the actor's own judgement, asked
    // here: decline what tmuxy owns and the precedence comes out the same way
    // round as if the actor had gone first.
    //
    // Only the ACTIVE pane's handler runs at all (`WidgetPane`), so an
    // inactive browser pane keeps showing frames and receives nothing.
    const session = instance;
    if (!session) return false;

    // Not when the user is typing into the pane's own chrome. This handler is
    // a capture-phase WINDOW listener, so it sees keys aimed at the address bar
    // too — and claiming them sends the address into the page and stops the
    // form submitting, which made the bar impossible to use at all. Found that
    // way: Enter in the address bar did nothing.
    //
    // The old handler only claimed `ctrl+r`, so the question never arose; a
    // widget that forwards everything has to ask it.
    if (isEditable(event.target)) return false;
    if (
      tmuxyOwnsKey(event, {
        prefixKey: context.keybindings?.prefix_key ?? '',
        prefixActive: context.prefixActive === true,
      })
    ) {
      return false;
    }

    // A modifier on its own is forwarded but not claimed: the page should know
    // Shift is down, and nothing else is waiting for the event.
    send({
      type: 'BROWSER_INPUT',
      session,
      method: 'Input.dispatchKeyEvent',
      params: keyEventParams(event),
    });
    return true;
  },
};

/**
 * Whether the keystroke is aimed at something the user is typing INTO.
 *
 * The pane's chrome — the address bar today — holds real inputs, and a key
 * meant for one of those belongs to it and not to the page.
 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * One keydown as CDP's `Input.dispatchKeyEvent` params.
 *
 * `text` is what decides whether a key TYPES or merely moves the caret, and it
 * must be present only for a printable key: sending `text: 'ArrowLeft'` inserts
 * that word into whatever has focus. A single-code-point `key` is the test —
 * every named key is longer.
 */
function keyEventParams(event: KeyboardEvent): Record<string, unknown> {
  const text = [...event.key].length === 1 ? event.key : undefined;
  return {
    type: text ? 'keyDown' : 'rawKeyDown',
    key: event.key,
    code: event.code,
    // alt 1, ctrl 2, meta 4, shift 8 — without these a page never sees
    // ctrl+click or shift+arrow.
    modifiers:
      (event.altKey ? 1 : 0) |
      (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) |
      (event.shiftKey ? 8 : 0),
    ...(text ? { text } : {}),
    windowsVirtualKeyCode: event.keyCode,
    nativeVirtualKeyCode: event.keyCode,
  };
}
