/**
 * International keyboard input (demo engine).
 *
 * A keyboard is not a stream of `key: 'a'` events. Layouts around the world
 * produce characters through four different paths, and three of them arrive
 * wearing modifier flags or IME markers that make a typed character look like a
 * command chord:
 *
 *   plain        `ç` on a Portuguese board, `ü` on a German one — no modifiers.
 *   dead key     `´` then `a` → ONE keydown carrying `á`, flagged keyCode 229
 *                because the OS composed it.
 *   compose key  macOS Option: Option+c → `ç`, Option+e e → `é`. altKey is set,
 *                but the letter has already been replaced by the character.
 *   AltGr        the third level of a layout: `@ { } ~` on ABNT2, `@ € µ` on
 *                German. Reported as ctrl+alt; only the AltGraph modifier state
 *                separates it from a real Ctrl+Alt chord.
 *
 * Plus IME composition (pinyin, kana, hangul, the emoji picker), which delivers
 * its text on `compositionend` rather than through keydown at all.
 *
 * Every story here types through the REAL chain — a `keydown` on window, exactly
 * as the browser fires it → keyboardActor → `send-keys` → demo tmux → the shell's
 * line editor → the rendered grid — and asserts the characters are painted on
 * screen, with their boxes inside the pane. Being in the DOM is not enough; a
 * dropped keystroke leaves no span at all, which is precisely the failure these
 * guard — dead-key characters were dropped in the browser, and Option and AltGr
 * characters were forwarded as `M-ç` / `C-M-@`, which tmux delivers as ESC-
 * prefixed meta sequences the shell throws away.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/International Input',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

// ---------------------------------------------------------------------------
// Typing — the event shapes real keyboards produce
// ---------------------------------------------------------------------------

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

/** A key that types itself: `a`, or a layout-native `ç` / `ü` / `й`. */
const plain = (char: string) => () => press({ key: char });

/**
 * A dead-key sequence: the accent key produces `Dead`, and the next key arrives
 * already composed. macOS routes that through the IME, so the event that
 * carries the finished character is stamped keyCode 229.
 */
const dead = (char: string) => () => {
  press({ key: 'Dead', keyCode: 229 });
  press({ key: char, keyCode: 229 });
};

/** macOS Option as a compose key: Option+c arrives as `ç` with altKey set. */
const option = (char: string) => () => press({ key: char, altKey: true });

/** AltGr third level: legacy ctrl+alt flags plus the AltGraph modifier state. */
const altGr = (char: string) => () =>
  press({ key: char, ctrlKey: true, altKey: true, modifierAltGraph: true });

/** IME composition (pinyin, kana, hangul, the emoji picker) committing `text`. */
const compose = (text: string) => () => {
  window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  for (const key of text) press({ key, keyCode: 229, isComposing: true });
  window.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
};

// ---------------------------------------------------------------------------
// Reading what landed on screen
// ---------------------------------------------------------------------------

/** The terminal row the demo shell is editing (the last one holding a prompt). */
function promptLine(canvasElement: HTMLElement): HTMLElement {
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
function runRect(line: HTMLElement, text: string): DOMRect {
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
function cellWidth(canvasElement: HTMLElement): number {
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
async function typeRun(
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
function expectPainted(canvasElement: HTMLElement, rect: DOMRect, cells?: number): void {
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

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * Dead keys — the reported bug. `´` + `a`, `~` + `o`, `¨` + `u`: the OS composes
 * the pair and hands the browser one keydown holding the finished character,
 * stamped keyCode 229. That stamp used to mean "an IME is mid-composition,
 * ignore this", so every accented character a dead key produced was dropped and
 * the diacritic was simply untypable.
 */
export const DeadKeyAccents: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const payload = 'áéíóúãõñüç';
    const rect = await typeRun(canvasElement, payload, Array.from(payload).map(dead));
    expectPainted(canvasElement, rect, payload.length + 2);
  },
};

/**
 * macOS Option as a compose key: Option+c → `ç`, Option+a → `å`, Option+p → `π`.
 * altKey is set, so these read as M- chords — but the OS has already swapped the
 * letter for the character. Forwarded as `M-ç`, tmux delivers ESC + ç, an
 * unbound meta sequence the shell discards, and the character never arrives. A
 * NON-ASCII key under bare Alt is therefore text; an ASCII one (Alt+x, still
 * `x`) stays a chord.
 */
export const ComposeKeyCharacters: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const payload = 'çåøπ£¥æœß';
    const rect = await typeRun(canvasElement, payload, Array.from(payload).map(option));
    expectPainted(canvasElement, rect, payload.length + 2);
  },
};

/**
 * AltGr third-level symbols — the programmer's row on a Brazilian ABNT2 or
 * German layout, where `@`, `{`, `}` and `~` are only reachable this way. The
 * legacy flags say ctrl+alt, which looked like a C-M- chord — and `C-M-@`
 * reaches the shell as ESC + NUL, not an `@`. The AltGraph modifier state is
 * what tells the two apart.
 */
export const AltGrSymbols: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const payload = '@€{}~µ¹²³';
    const rect = await typeRun(canvasElement, payload, Array.from(payload).map(altGr));
    expectPainted(canvasElement, rect, payload.length + 2);
  },
};

/**
 * Characters a layout puts on a plain, unmodified key: `ç ã õ` on Portuguese,
 * `ä ö ü ß` on German, `é è à ù` on French, `å ø æ` on Nordic boards. No
 * modifiers, no IME — the path that always worked, kept here so a future change
 * to the text/chord split cannot quietly regress the simplest case.
 */
export const LayoutNativeAccents: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const payload = 'çãõäöüßéèàùåøæ';
    const rect = await typeRun(canvasElement, payload, Array.from(payload).map(plain));
    expectPainted(canvasElement, rect, payload.length + 2);
  },
};

/**
 * Non-Latin scripts that type one key per character: Greek, Cyrillic, Hebrew and
 * Arabic (both right-to-left), Devanagari, Thai, Armenian, Georgian. These reach
 * tmux as literal text, so the whole range of `event.key` values a keyboard can
 * emit has to survive the trip — not just the Latin-1 ones.
 */
export const NonLatinScripts: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const payload = 'αβγЖийשלוםمرحباनमثทยԱբჩ';
    const rect = await typeRun(canvasElement, payload, Array.from(payload).map(plain));
    expectPainted(canvasElement, rect);
  },
};

/**
 * IME composition: pinyin, kana and hangul never deliver text through keydown —
 * the individual keys are suppressed while composing and the committed string
 * arrives whole on `compositionend`. The macOS emoji picker uses the same path,
 * and an emoji is a two-code-unit string the user typed as ONE character, so it
 * must occupy one cell rather than being split into two half-glyphs.
 */
export const IMEComposedText: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const payload = '日本語한국어😀';
    const rect = await typeRun(canvasElement, payload, [
      compose('日本語'),
      compose('한국어'),
      compose('😀'),
    ]);
    expectPainted(canvasElement, rect);

    // The emoji is ONE cell holding both its code units, not a surrogate pair
    // torn across two cells — which paints two broken halves and shifts
    // everything after it a column right. Text alone can't tell the two apart
    // (the halves concatenate back into the same string), so assert the boxes:
    // exactly one cell renders it, and it is one cell wide.
    const emojiCells = Array.from(
      promptLine(canvasElement).querySelectorAll<HTMLElement>('span'),
    ).filter((s) => s.textContent === '😀');
    expect(emojiCells).toHaveLength(1);
    expect(emojiCells[0].getBoundingClientRect().width).toBeCloseTo(cellWidth(canvasElement), 0);
  },
};

/**
 * The other side of the discriminator: chords must stay chords. Alt+x is a real
 * M-x (its key is still ASCII — the OS composed nothing), Cmd+x is a menu-level
 * chord, and macOS Option+h arrives as `˙` but is claimed as M-h for pane
 * navigation. None of the three may leak a character into the line, which would
 * turn every keyboard shortcut into garbage on screen.
 */
export const ChordsAreNotText: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    const rect = await typeRun(canvasElement, '', [
      () => press({ key: 'x', altKey: true }),
      () => press({ key: 'x', metaKey: true }),
      () => press({ key: '˙', altKey: true }),
    ]);
    // Exactly the two brackets: the chords typed nothing between them.
    expectPainted(canvasElement, rect, 2);
  },
};
