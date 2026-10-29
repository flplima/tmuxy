/**
 * The phone key row's ctrl and alt: a phone keyboard has neither, so a tap
 * latches one for the next key, and a second tap while latched locks it until
 * a third. The next key — from the key row or the phone's own keyboard —
 * takes whatever is latched or locked, and a latch (not a lock) lets go.
 *
 * Module state, read by the key row through `useSyncExternalStore` and taken
 * by the keyboard actor when the next key arrives.
 */

export type Modifier = 'ctrl' | 'alt';
export type LatchState = 'off' | 'latched' | 'locked';

export type Latches = Readonly<Record<Modifier, LatchState>>;

const NEXT: Record<LatchState, LatchState> = { off: 'latched', latched: 'locked', locked: 'off' };

let latches: Latches = { ctrl: 'off', alt: 'off' };
const listeners = new Set<() => void>();

function set(next: Latches): void {
  latches = next;
  listeners.forEach((listener) => listener());
}

export function subscribeLatches(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLatches(): Latches {
  return latches;
}

/** A tap on the modifier's key: off → latched → locked → off. */
export function tapModifier(modifier: Modifier): void {
  set({ ...latches, [modifier]: NEXT[latches[modifier]] });
}

/**
 * The modifiers the next key carries, or null when none is on. Taking them
 * releases a latch; a lock stays.
 */
export function takeModifiers(): { ctrlKey: boolean; altKey: boolean } | null {
  const ctrlKey = latches.ctrl !== 'off';
  const altKey = latches.alt !== 'off';
  if (!ctrlKey && !altKey) return null;
  set({
    ctrl: latches.ctrl === 'latched' ? 'off' : latches.ctrl,
    alt: latches.alt === 'latched' ? 'off' : latches.alt,
  });
  return { ctrlKey, altKey };
}

/** Drop every latch and lock. */
export function resetLatches(): void {
  set({ ctrl: 'off', alt: 'off' });
}

/**
 * Press a key the way the keyboard would, carrying whatever is latched: a
 * keydown on the window, where the keyboard actor reads every key — so the
 * prefix, the bindings and copy mode see it exactly as a typed key.
 */
export function pressKey(key: string): void {
  const modifiers = takeModifiers();
  dispatchKeydown({
    key,
    ctrlKey: modifiers?.ctrlKey ?? false,
    altKey: modifiers?.altKey ?? false,
  });
}

/**
 * Press a chord as given — the prefix key from the bindings — with no latch
 * taken: it is a whole key of its own, not a key for ctrl or alt to colour.
 */
export function pressChord(init: KeyboardEventInit): void {
  dispatchKeydown(init);
}

function dispatchKeydown(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }));
}
