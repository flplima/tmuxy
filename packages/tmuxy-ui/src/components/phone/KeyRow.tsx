/**
 * KeyRow — the keys a phone keyboard has no key for, in two even rows of six
 * under the terminal, so each key is as wide as the screen allows.
 *
 * Each key is pressed through the keyboard path (`infra/dom/keyLatch` → a keydown
 * on the window), so the prefix, the bindings and copy mode treat it as a typed
 * key. ctrl and alt latch for the next key, from this row or the phone's own
 * keyboard; a second tap locks them. The prefix key presses the prefix the
 * bindings name as one chord; a second tap while armed cancels it, as Escape does.
 * The mic listens until the speaker pauses and types what it heard into the
 * pane as the phone keyboard would (`infra/dictation`); it is lit while it
 * listens, and a second tap stops it.
 *
 * A key never takes focus: the hidden input keeps it, so the phone keyboard
 * stays up while the row is used.
 */

import { memo, useEffect, useMemo, useState, useSyncExternalStore, type PointerEvent } from 'react';
import {
  getLatches,
  pressChord,
  pressKey,
  subscribeLatches,
  tapModifier,
  type Modifier,
} from '../../infra/dom/keyLatch';
import { createKeyRepeat } from './keyRepeat';
import { toggleMobileKeyboard, typeText } from '../../infra/dom/mobileKeyboard';
import { createDictation } from '../../infra/dictation';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import { selectKeyBindings, selectPrefixActive } from '../../machines/selectors/ui';
import { keyEventInitOf } from '../../machines/actors/keyboard/keyFormatting';
import './KeyRow.css';
import { DEFAULT_PREFIX } from '../../domain/tmuxyConstants.gen';

type RowKey =
  | { kind: 'key'; label: string; key: string; name: string; arrow?: true }
  | { kind: 'modifier'; label: string; modifier: Modifier; name: string }
  | { kind: 'prefix'; label: string; name: string }
  | { kind: 'keyboard'; label: string; name: string }
  | { kind: 'mic'; label: string; name: string };

const KEYS: readonly RowKey[] = [
  { kind: 'key', label: 'esc', key: 'Escape', name: 'Escape' },
  { kind: 'key', label: 'tab', key: 'Tab', name: 'Tab' },
  { kind: 'modifier', label: 'ctrl', modifier: 'ctrl', name: 'Control' },
  { kind: 'modifier', label: 'alt', modifier: 'alt', name: 'Alt' },
  { kind: 'prefix', label: 'prefix', name: 'Prefix' },
  { kind: 'keyboard', label: '⌨', name: 'Toggle keyboard' },
  { kind: 'key', label: '←', key: 'ArrowLeft', name: 'Left', arrow: true },
  { kind: 'key', label: '↑', key: 'ArrowUp', name: 'Up', arrow: true },
  { kind: 'key', label: '↓', key: 'ArrowDown', name: 'Down', arrow: true },
  { kind: 'key', label: '→', key: 'ArrowRight', name: 'Right', arrow: true },
  { kind: 'key', label: '⏎', key: 'Enter', name: 'Enter' },
  { kind: 'mic', label: 'mic', name: 'Dictate' },
];

/** A microphone: a capsule on a stand. */
function Mic() {
  return (
    <svg
      className="key-row-icon"
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="6.25" y="1.75" width="5.5" height="9" rx="2.75" />
      <path d="M3.5 8.5a5.5 5.5 0 0 0 11 0" />
      <line x1="9" y1="14" x2="9" y2="16.25" />
    </svg>
  );
}

function arrowAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y)?.closest('[data-arrow]');
  return el?.getAttribute('data-arrow') ?? null;
}

export const KeyRow = memo(function KeyRow() {
  const latches = useSyncExternalStore(subscribeLatches, getLatches);
  const send = useAppSend();
  const activePaneId = useAppSelector((ctx) => ctx.activePaneId);
  const [listening, setListening] = useState(false);
  const dictation = useMemo(
    () =>
      createDictation({
        onText: typeText,
        onListening: setListening,
        onError: (text) => send({ type: 'NOTIFY', kind: 'error', text }),
      }),
    [send],
  );
  useEffect(() => () => dictation.dispose(), [dictation]);
  const prefixActive = useAppSelector(selectPrefixActive);
  const prefixKey = useAppSelector(selectKeyBindings)?.prefix_key ?? DEFAULT_PREFIX;
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
      case 'mic':
        return dictation.toggle();
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
            : k.kind === 'mic'
              ? listening
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
            {k.kind === 'mic' ? <Mic /> : k.label}
          </button>
        );
      })}
    </div>
  );
});
