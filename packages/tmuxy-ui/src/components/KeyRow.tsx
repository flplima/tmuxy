/**
 * KeyRow — the keys a phone keyboard has no key for, in two rows under the
 * terminal: esc, tab, ctrl, alt, the keyboard and the zoom on the first; the
 * arrows, enter and the app menu on the second. Two rows so each key is a
 * thumb's size.
 *
 * Each key is pressed through the keyboard path (`utils/keyLatch` → a keydown
 * on the window), so the prefix, the bindings and copy mode treat it as a
 * typed key. ctrl and alt latch for the next key, from this row or the phone's
 * own keyboard, and show it in inverse video; a second tap locks them.
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

import { memo, useSyncExternalStore } from 'react';
import {
  getLatches,
  pressKey,
  subscribeLatches,
  tapModifier,
  type Modifier,
} from '../utils/keyLatch';
import { toggleMobileKeyboard } from '../utils/mobileKeyboard';
import { useAppSelector, useAppSend } from '../machines/appHooks';
import { selectPhoneZoom } from '../machines/selectors/layout';
import { AppMenu } from './menus/AppMenu';
import './KeyRow.css';

type RowKey =
  | { kind: 'key'; label: string; key: string; name: string }
  | { kind: 'modifier'; label: string; modifier: Modifier; name: string }
  | { kind: 'keyboard'; label: string; name: string }
  | { kind: 'zoom'; label: string; name: string };

const KEYS: readonly RowKey[] = [
  { kind: 'key', label: 'esc', key: 'Escape', name: 'Escape' },
  { kind: 'key', label: 'tab', key: 'Tab', name: 'Tab' },
  { kind: 'modifier', label: 'ctrl', modifier: 'ctrl', name: 'Control' },
  { kind: 'modifier', label: 'alt', modifier: 'alt', name: 'Alt' },
  { kind: 'keyboard', label: '⌨', name: 'Toggle keyboard' },
  { kind: 'zoom', label: '⤢', name: 'Toggle zoom' },
  { kind: 'key', label: '←', key: 'ArrowLeft', name: 'Left' },
  { kind: 'key', label: '↑', key: 'ArrowUp', name: 'Up' },
  { kind: 'key', label: '↓', key: 'ArrowDown', name: 'Down' },
  { kind: 'key', label: '→', key: 'ArrowRight', name: 'Right' },
  { kind: 'key', label: '⏎', key: 'Enter', name: 'Enter' },
];

export const KeyRow = memo(function KeyRow() {
  const latches = useSyncExternalStore(subscribeLatches, getLatches);
  const send = useAppSend();
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const zoomed = useAppSelector(selectPhoneZoom) !== null;

  const press = (k: RowKey) => {
    switch (k.kind) {
      case 'modifier':
        return tapModifier(k.modifier);
      case 'keyboard':
        return toggleMobileKeyboard(activePaneId);
      case 'zoom':
        return send({ type: 'TOGGLE_PHONE_ZOOM' });
      default:
        return pressKey(k.key);
    }
  };

  return (
    <div className="key-row" role="toolbar" aria-label="Keys">
      {KEYS.map((k) => {
        const pressed =
          k.kind === 'modifier' ? latches[k.modifier] !== 'off' : k.kind === 'zoom' ? zoomed : null;
        const locked = k.kind === 'modifier' && latches[k.modifier] === 'locked';
        return (
          <button
            key={k.label}
            type="button"
            className={`key-row-key${pressed ? ' is-latched' : ''}${locked ? ' is-locked' : ''}`}
            aria-label={k.name}
            aria-pressed={pressed ?? undefined}
            data-key-row={k.label}
            tabIndex={-1}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(k)}
          >
            {k.label}
          </button>
        );
      })}
      <AppMenu />
    </div>
  );
});
