import { expect, waitFor } from 'storybook/test';

// ---------------------------------------------------------------------------
// Typing — the event shapes real keyboards produce
// ---------------------------------------------------------------------------

/**
 * The element real key events target: the hidden input that holds browser
 * focus once a pane exists, so an IME has somewhere to compose. A text keydown
 * the actor lets through then becomes an `input` event, which the browser
 * fires and this helper reproduces — that second delivery is exactly what a
 * dropped or doubled character would show up in.
 */
export const focusTarget = (): EventTarget => document.activeElement ?? window;

export function press(init: KeyboardEventInit): void {
  const target = focusTarget();
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  const input = target as HTMLInputElement;
  const typed = init.key ?? '';
  if (
    !event.defaultPrevented &&
    input instanceof HTMLInputElement &&
    Array.from(typed).length === 1 &&
    !init.isComposing
  ) {
    input.value = typed;
    input.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: typed, inputType: 'insertText' }),
    );
  }
}

/** A key that types itself: `a`, or a layout-native `ç` / `ü` / `й`. */
export const plain = (char: string) => () => press({ key: char });

/** IME composition (pinyin, kana, hangul, the emoji picker) committing `text`. */
export const compose = (text: string) => () => {
  const target = focusTarget();
  target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  for (const key of text) press({ key, keyCode: 229, isComposing: true });
  target.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
  // Chrome follows compositionend with an `input` carrying the same text; a
  // composition committed twice would paint the text twice.
  if (target instanceof HTMLInputElement) {
    target.value = text;
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
    );
  }
};

/**
 * A dead key as the OS actually composes it, which is not a keydown at all.
 *
 * WebKit — the engine the desktop app runs on — routes a dead key through the
 * IME when an editable element has focus: `compositionstart`, an update
 * carrying the bare accent, then `compositionend` holding the finished
 * character. Nothing about that reaches the keydown path, so the character
 * arrives only if the hidden input is where the composition happened.
 */
export const deadComposed = (accent: string, letter: string, composed: string) => () => {
  const target = focusTarget();
  target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  press({ key: 'Dead', keyCode: 229, isComposing: true });
  target.dispatchEvent(new CompositionEvent('compositionupdate', { data: accent, bubbles: true }));
  press({ key: letter, keyCode: 229, isComposing: true });
  target.dispatchEvent(new CompositionEvent('compositionend', { data: composed, bubbles: true }));
  if (target instanceof HTMLInputElement) {
    target.value = composed;
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: composed, inputType: 'insertText' }),
    );
  }
};

// ---------------------------------------------------------------------------
// Reading what landed on screen
// ---------------------------------------------------------------------------

/** The terminal row the demo shell is editing (the last one holding a prompt). */
export function promptLine(canvasElement: HTMLElement): HTMLElement {
  const lines = Array.from(canvasElement.querySelectorAll<HTMLElement>('.terminal-line'));
  const line = lines.filter((l) => (l.textContent ?? '').includes('$ ')).pop();
  if (!line) throw new Error('no prompt line rendered yet');
  return line;
}

/**
 * Box of `text` where it is painted on `line`, located by character offset so an
 * identical substring elsewhere on the row (the prompt's own `@` in
 * `demo@tmuxy`) cannot stand in for the typed one. A Range is used rather than
 * span boxes because a run's span often extends past the text with the rest of
 * the row's blank cells.
 */
export function runRect(line: HTMLElement, text: string): DOMRect {
  const at = (line.textContent ?? '').indexOf(text);
  if (at < 0) throw new Error(`"${text}" is not on the prompt line`);

  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = (node.textContent ?? '').length;
    if (!started && at < offset + len) {
      range.setStart(node, at - offset);
      started = true;
    }
    if (started && at + text.length <= offset + len) {
      range.setEnd(node, at + text.length - offset);
      return range.getBoundingClientRect();
    }
    offset += len;
  }
  throw new Error(`"${text}" spans past the end of the prompt line`);
}

/** The measured terminal cell width, published by the app as `--cell-w`. */
export function cellWidth(canvasElement: HTMLElement): number {
  const pane = canvasElement.querySelector<HTMLElement>('[data-pane-id]');
  if (!pane) throw new Error('no pane rendered');
  const w = parseFloat(getComputedStyle(pane).getPropertyValue('--cell-w'));
  if (!(w > 0)) throw new Error(`--cell-w not published (got "${w}")`);
  return w;
}

/**
 * Type `payload` between two ASCII brackets — neither appears in the demo
 * prompt, so the delimiters pin the assertion to the characters this story
 * typed — then wait for `[payload]` to be rendered and return its box.
 */
export async function typeRun(
  canvasElement: HTMLElement,
  payload: string,
  keys: Array<() => void>,
): Promise<DOMRect> {
  await waitFor(() => expect(promptLine(canvasElement)).toBeTruthy(), { timeout: 15000 });
  press({ key: '[' });
  for (const k of keys) k();
  press({ key: ']' });

  const marked = `[${payload}]`;
  await waitFor(() => expect(promptLine(canvasElement).textContent ?? '').toContain(marked), {
    timeout: 15000,
    interval: 100,
  });
  return runRect(promptLine(canvasElement), marked);
}

/**
 * The typed run must be painted inside the pane, not merely present: a non-empty
 * box that sits within the pane's own box. `cells` additionally pins the advance
 * — every character owns exactly one cell — for runs made only of narrow
 * characters (CJK and emoji advance wider than their cell, so they opt out).
 */
export function expectPainted(canvasElement: HTMLElement, rect: DOMRect, cells?: number): void {
  const pane = canvasElement.querySelector<HTMLElement>('[data-pane-id]')!;
  const paneRect = pane.getBoundingClientRect();

  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(rect.left).toBeGreaterThanOrEqual(paneRect.left - 1);
  expect(rect.right).toBeLessThanOrEqual(paneRect.right + 1);
  expect(rect.top).toBeGreaterThanOrEqual(paneRect.top - 1);
  expect(rect.bottom).toBeLessThanOrEqual(paneRect.bottom + 1);

  if (cells !== undefined) {
    expect(rect.width / cellWidth(canvasElement)).toBeCloseTo(cells, 0);
  }
}
