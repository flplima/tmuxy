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
 * Held, ⌨ opens the compose sheet instead (ComposeSheet.tsx, useComposeHold.ts):
 * the whole screen to write in with the phone keyboard's autocorrect and
 * suggestions, pasted into the active pane at once.
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
import { ComposeSheet } from './ComposeSheet';
import { useComposeHold } from './useComposeHold';
import { toggleMobileKeyboard, typeText } from '../../infra/dom/mobileKeyboard';
import { createDictation } from '../../infra/dictation';
import { useAppSelector, useAppSend } from '../../machines/appHooks';
import { selectKeyBindings, selectPrefixActive } from '../../machines/selectors/ui';
import { selectPaneById } from '../../machines/selectors/panesAndSidebars';
import { TmuxOp } from '../../domain/commands';
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
  const activePane = useAppSelector((ctx) =>
    activePaneId ? selectPaneById(ctx, activePaneId) : undefined,
  );

  const compose = useComposeHold();
  const sendComposed = (text: string) => {
    if (!activePaneId) return;
    send({ type: 'DISPATCH_OP', op: TmuxOp.PasteText({ target: activePaneId, text }) });
  };

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
        if (compose.wasHeld()) return;
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
  // The finger off a key: no longer pressed, and an arrow's repeat or ⌨'s hold ends.
  const release = (k: RowKey, e: PointerEvent<HTMLButtonElement>) => {
    delete e.currentTarget.dataset.down;
    if (k.kind === 'keyboard') compose.up();
    else if (k.kind === 'key' && k.arrow) arrowUp();
  };

  return (
    <div className="key-row" role="toolbar" aria-label="Keys">
      {compose.composing && (
        <ComposeSheet
          title={
            activePane
              ? `Send to pane ${activePane.tmuxId} - ${activePane.command}`
              : 'Send to the pane'
          }
          inputRef={compose.inputRef}
          onSend={sendComposed}
          onClose={compose.close}
        />
      )}
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
        const keyboard = k.kind === 'keyboard';
        return (
          <button
            key={k.label}
            type="button"
            className={`key-row-key${pressed ? ' is-latched' : ''}${locked ? ' is-locked' : ''}`}
            aria-label={
              k.kind === 'prefix'
                ? `Prefix (${prefixKey})`
                : keyboard
                  ? `${k.name} (hold to write and send)`
                  : k.name
            }
            aria-pressed={pressed ?? undefined}
            data-key-row={k.label}
            data-arrow={arrow ? k.key : undefined}
            tabIndex={-1}
            onPointerDown={(e) => {
              e.preventDefault();
              e.currentTarget.dataset.down = '';
              if (keyboard) compose.down(e);
              arrowDown(k, e);
            }}
            onPointerMove={arrow ? arrowMove : undefined}
            onPointerUp={(e) => release(k, e)}
            onPointerCancel={(e) => release(k, e)}
            onPointerLeave={(e) => delete e.currentTarget.dataset.down}
            onContextMenu={keyboard ? (e) => e.preventDefault() : undefined}
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
