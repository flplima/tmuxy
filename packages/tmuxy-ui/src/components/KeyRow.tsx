/**
 * KeyRow — the keys a phone keyboard has no key for, in a row under the
 * terminal: esc, tab, ctrl, alt, the arrows and enter.
 *
 * Each key is pressed through the keyboard path (`utils/keyLatch` → a keydown
 * on the window), so the prefix, the bindings and copy mode treat it as a
 * typed key. ctrl and alt latch for the next key, from this row or the phone's
 * own keyboard, and show it in inverse video; a second tap locks them.
 *
 * A key never takes focus: the hidden input keeps it, so the phone keyboard
 * stays up while the row is used.
 */

import { memo, useSyncExternalStore } from 'react';
import {
  getLatches,
  pressKey,
  subscribeLatches,
  tapModifier,
  type Modifier,
} from '../utils/keyLatch';
import './KeyRow.css';

type RowKey =
  | { kind: 'key'; label: string; key: string; name: string }
  | { kind: 'modifier'; label: string; modifier: Modifier; name: string };

const KEYS: readonly RowKey[] = [
  { kind: 'key', label: 'esc', key: 'Escape', name: 'Escape' },
  { kind: 'key', label: 'tab', key: 'Tab', name: 'Tab' },
  { kind: 'modifier', label: 'ctrl', modifier: 'ctrl', name: 'Control' },
  { kind: 'modifier', label: 'alt', modifier: 'alt', name: 'Alt' },
  { kind: 'key', label: '←', key: 'ArrowLeft', name: 'Left' },
  { kind: 'key', label: '↑', key: 'ArrowUp', name: 'Up' },
  { kind: 'key', label: '↓', key: 'ArrowDown', name: 'Down' },
  { kind: 'key', label: '→', key: 'ArrowRight', name: 'Right' },
  { kind: 'key', label: '⏎', key: 'Enter', name: 'Enter' },
];

export const KeyRow = memo(function KeyRow() {
  const latches = useSyncExternalStore(subscribeLatches, getLatches);

  return (
    <div className="key-row" role="toolbar" aria-label="Keys">
      {KEYS.map((k) => {
        const state = k.kind === 'modifier' ? latches[k.modifier] : 'off';
        return (
          <button
            key={k.label}
            type="button"
            className={`key-row-key${state !== 'off' ? ' is-latched' : ''}${
              state === 'locked' ? ' is-locked' : ''
            }`}
            aria-label={k.name}
            aria-pressed={k.kind === 'modifier' ? state !== 'off' : undefined}
            data-key-row={k.label}
            tabIndex={-1}
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => (k.kind === 'modifier' ? tapModifier(k.modifier) : pressKey(k.key))}
          >
            {k.label}
          </button>
        );
      })}
    </div>
  );
});
