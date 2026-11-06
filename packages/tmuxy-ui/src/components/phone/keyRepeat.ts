/**
 * A key held down on the phone's key row repeats the way a hardware key does.
 * A finger that slides onto another key hands the repeat over to it, so the
 * arrows work as one pad: down on ↑, over to ↓, no lift between.
 */

export interface KeyRepeat {
  start(key: string): void;
  /** The finger, still down, is over `key` (or over nothing): repeat that instead. */
  slide(key: string | null): void;
  stop(): void;
  readonly current: string | null;
}

export interface KeyRepeatTiming {
  /** From the first press to the first repeat, in ms. */
  delay: number;
  /** Between repeats, in ms. */
  interval: number;
}

/** A hardware keyboard's feel: a beat, then about sixteen a second. */
export const KEY_REPEAT: KeyRepeatTiming = { delay: 350, interval: 60 };

export function createKeyRepeat(
  press: (key: string) => void,
  timing: KeyRepeatTiming = KEY_REPEAT,
): KeyRepeat {
  let current: string | null = null;
  let held = false;
  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const clear = () => {
    if (delayTimer !== null) clearTimeout(delayTimer);
    if (intervalTimer !== null) clearInterval(intervalTimer);
    delayTimer = null;
    intervalTimer = null;
  };

  const begin = (key: string) => {
    clear();
    current = key;
    press(key);
    delayTimer = setTimeout(() => {
      delayTimer = null;
      intervalTimer = setInterval(() => press(key), timing.interval);
    }, timing.delay);
  };

  return {
    start(key) {
      held = true;
      begin(key);
    },
    slide(key) {
      if (!held || key === current) return;
      if (key === null) {
        clear();
        current = null;
        return;
      }
      begin(key);
    },
    stop() {
      held = false;
      clear();
      current = null;
    },
    get current() {
      return current;
    },
  };
}
