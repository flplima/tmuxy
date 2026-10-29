/**
 * KeyRow — the keys a phone keyboard has no key for, in two rows under the
 * terminal: esc, tab, ctrl, alt, the prefix, the keyboard and the zoom on the
 * first; the arrows, enter and the app menu on the second. Two rows so each
 * key is a thumb's size.
 *
 * Each key is pressed through the keyboard path (`utils/keyLatch` → a keydown
 * on the window), so the prefix, the bindings and copy mode treat it as a
 * typed key. ctrl and alt latch for the next key, from this row or the phone's
 * own keyboard, and show it in inverse video; a second tap locks them.
 *
 * The prefix key presses the prefix the bindings name (`C-a` unless the config
 * says otherwise) as one chord, and is lit while the prefix is armed — the
 * state the desktop's status bar shows as a chip. A second tap while armed
 * cancels it, as Escape does.
 *
 * The arrows repeat while held and work as one pad: a finger that lands on
 * one and slides onto another presses that one instead (`utils/keyRepeat`).
 *
 * ⌨ puts the phone's keyboard up or away (a tap on a pane only focuses it —
 * utils/mobileKeyboard.ts), and ⤢ zooms the terminal in the browser or puts
 * it back, as a double tap on it does (the `phone` slice).
 *
 * A key never takes focus: the hidden input keeps it, so the phone keyboard
 * stays up while the row is used.
 *
 * The row ends with the app menu: a phone has no status bar, and this row is
 * the one piece of chrome it keeps.
 */

import { memo, useMemo, useSyncExternalStore, type PointerEvent } from 'react';
import {
  getLatches,
  pressChord,
  pressKey,
  subscribeLatches,
  tapModifier,
  type Modifier,
} from '../utils/keyLatch';
import { createKeyRepeat } from '../utils/keyRepeat';
import { toggleMobileKeyboard } from '../utils/mobileKeyboard';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectPhoneZoom } from '../machines/selectors/layout';
import { selectKeyBindings, selectPrefixActive } from '../machines/selectors/ui';
import { keyEventInitOf } from '../machines/actors/keyboard/keyFormatting';
import { AppMenu } from './menus/AppMenu';
import './KeyRow.css';

type RowKey =
  | { kind: 'key'; label: string; key: string; name: string; arrow?: true }
  | { kind: 'modifier'; label: string; modifier: Modifier; name: string }
  | { kind: 'prefix'; label: string; name: string }
  | { kind: 'keyboard'; label: string; name: string }
  | { kind: 'zoom'; label: string; name: string };

const KEYS: readonly RowKey[] = [
  { kind: 'key', label: 'esc', key: 'Escape', name: 'Escape' },
  { kind: 'key', label: 'tab', key: 'Tab', name: 'Tab' },
  { kind: 'modifier', label: 'ctrl', modifier: 'ctrl', name: 'Control' },
  { kind: 'modifier', label: 'alt', modifier: 'alt', name: 'Alt' },
  { kind: 'prefix', label: 'prefix', name: 'Prefix' },
  { kind: 'keyboard', label: '⌨', name: 'Toggle keyboard' },
  { kind: 'zoom', label: '⤢', name: 'Toggle zoom' },
  { kind: 'key', label: '←', key: 'ArrowLeft', name: 'Left', arrow: true },
  { kind: 'key', label: '↑', key: 'ArrowUp', name: 'Up', arrow: true },
  { kind: 'key', label: '↓', key: 'ArrowDown', name: 'Down', arrow: true },
  { kind: 'key', label: '→', key: 'ArrowRight', name: 'Right', arrow: true },
  { kind: 'key', label: '⏎', key: 'Enter', name: 'Enter' },
];

/** The arrow key under a point on screen, by the DOM key it presses. */
function arrowAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-arrow]');
  return el?.getAttribute('data-arrow') ?? null;
}

export const KeyRow = memo(function KeyRow() {
  const latches = useSyncExternalStore(subscribeLatches, getLatches);
  const send = useAppSend();
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const zoomed = useAppSelector(selectPhoneZoom) !== null;
  const prefixActive = useAppSelector(selectPrefixActive);
  const prefixKey = useAppSelector(selectKeyBindings)?.prefix_key ?? 'C-a';
  const repeat = useMemo(() => createKeyRepeat(pressKey), []);

  const press = (k: RowKey) => {
    switch (k.kind) {
      case 'modifier':
        return tapModifier(k.modifier);
      case 'prefix': {
        if (prefixActive) return pressKey('Escape');
        const chord = keyEventInitOf(prefixKey);
        return chord ? pressChord(chord) : undefined;
      }
      case 'keyboard':
        return toggleMobileKeyboard(activePaneId);
      case 'zoom':
        return send({ type: 'TOGGLE_PHONE_ZOOM' });
      default:
        return pressKey(k.key);
    }
  };

  // The arrows press on touch, not on the click after it: the repeat and the
  // slide both start the moment the finger lands.
  const arrowDown = (k: RowKey, e: PointerEvent<HTMLButtonElement>) => {
    if (k.kind !== 'key' || !k.arrow) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    repeat.start(k.key);
  };
  const arrowMove = (e: PointerEvent<HTMLButtonElement>) => {
    if (repeat.current === null && !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    repeat.slide(arrowAt(e.clientX, e.clientY));
  };
  const arrowUp = () => repeat.stop();

  return (
    <div className="key-row" role="toolbar" aria-label="Keys">
      {KEYS.map((k) => {
        const pressed =
          k.kind === 'modifier'
            ? latches[k.modifier] !== 'off'
            : k.kind === 'zoom'
              ? zoomed
              : k.kind === 'prefix'
                ? prefixActive
                : null;
        const locked = k.kind === 'modifier' && latches[k.modifier] === 'locked';
        const arrow = k.kind === 'key' && k.arrow === true;
        return (
          <button
            key={k.label}
            type="button"
            className={`key-row-key${pressed ? ' is-latched' : ''}${locked ? ' is-locked' : ''}`}
            aria-label={k.kind === 'prefix' ? `Prefix (${prefixKey})` : k.name}
            aria-pressed={pressed ?? undefined}
            data-key-row={k.label}
            data-arrow={arrow ? k.key : undefined}
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              arrowDown(k, e);
            }}
            onPointerMove={arrow ? arrowMove : undefined}
            onPointerUp={arrow ? arrowUp : undefined}
            onPointerCancel={arrow ? arrowUp : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={arrow ? undefined : () => press(k)}
          >
            {k.label}
          </button>
        );
      })}
      <AppMenu />
    </div>
  );
});
