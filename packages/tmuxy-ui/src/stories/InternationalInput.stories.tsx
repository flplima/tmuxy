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
import {
  altGr,
  cellWidth,
  compose,
  dead,
  deadComposed,
  DIACRITICS_LANGUAGES,
  expectPainted,
  option,
  plain,
  press,
  promptLine,
  typeRun,
} from './internationalInputHelpers';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/International Input',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

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
 * Where an IME composes. A composition can only begin inside an editable
 * element, and until PR #61 nothing on the desktop ever had one — the hidden
 * input existed for touch keyboards only, so Korean, Japanese and Chinese
 * input had nowhere to start. Now the input takes browser focus as soon as a
 * pane exists and follows the pane holding the keyboard. Text typed into it
 * arrives once: a plain key by its `input` event, a composition by its
 * `compositionend`, with the `input` event Chrome fires after that commit
 * de-duplicated rather than painted a second time.
 */
export const HiddenInputOwnsFocus: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(promptLine(canvasElement)).toBeTruthy(), { timeout: 15000 });
    await waitFor(() => {
      const active = document.activeElement as HTMLInputElement | null;
      expect(active?.tagName).toBe('INPUT');
    });

    const composed = await typeRun(canvasElement, '한글', [compose('한글')]);
    expectPainted(canvasElement, composed);
    expect(promptLine(canvasElement).textContent ?? '').not.toContain('한글한글');

    const typed = await typeRun(canvasElement, 'ab', [plain('a'), plain('b')]);
    expectPainted(canvasElement, typed, 4);
    expect(promptLine(canvasElement).textContent ?? '').not.toContain('aabb');
  },
};

export const DeadKeysThroughTheIME: Story = {
  args: { height: 420 },
  parameters: {
    docs: {
      description: {
        story:
          'The same accents again, composed the way WebKit does it: a composition on the hidden input rather than a keydown carrying the finished character. Both shapes have to work, because which one you get depends on the engine and on whether anything editable has focus.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const pairs: Array<[string, string, string]> = [
      ['´', 'a', 'á'],
      ['~', 'a', 'ã'],
      ['^', 'e', 'ê'],
      ['`', 'a', 'à'],
      ['~', 'n', 'ñ'],
      ['¨', 'u', 'ü'],
    ];
    const payload = pairs.map(([, , composed]) => composed).join('');
    const rect = await typeRun(
      canvasElement,
      payload,
      pairs.map(([accent, letter, composed]) => deadComposed(accent, letter, composed)),
    );
    expectPainted(canvasElement, rect, payload.length + 2);
  },
};

/**
 * Clicking into a pane must not cost you your accents.
 *
 * The pane wrapper is the grid's tab stop, so a click moves browser focus onto
 * it — and a dead key is composed by the OS for whatever is being EDITED. With
 * focus on a plain div there is nowhere for the composed character to go, and
 * it is simply never delivered. Ordinary keys keep working, which is why this
 * reads as "diacritics stopped working" rather than "typing stopped working".
 * The pane hands focus straight back to the hidden input.
 */
export const ClickingAPaneKeepsAccentsTypable: Story = {
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(promptLine(canvasElement)).toBeTruthy(), { timeout: 15000 });
    const hidden = document.activeElement;
    expect(hidden?.tagName).toBe('INPUT');

    // Click the pane, the way anyone starts using one.
    const pane = canvasElement.querySelector<HTMLElement>('.pane-wrapper[data-pane-id]')!;
    pane.focus();
    await waitFor(() => expect(document.activeElement).toBe(hidden));

    // ...and a composed accent still lands.
    const payload = 'áñ';
    const rect = await typeRun(canvasElement, payload, [
      deadComposed('´', 'a', 'á'),
      deadComposed('~', 'n', 'ñ'),
    ]);
    expectPainted(canvasElement, rect, payload.length + 2);
  },
};

/**
 * The diacritics of the languages that use them most, typed as plain keys —
 * the path a layout takes when the character has a key of its own.
 *
 * Portuguese and Spanish are the reported ones; the rest are here because a
 * change to the text/chord split breaks them all at once, and a single payload
 * covering French, German, Nordic, Polish, Czech, Turkish, Romanian, Hungarian
 * and Vietnamese says so in one failure rather than in a bug report months
 * later.
 */
export const DiacriticsOfManyLanguages: Story = {
  tags: ['nightly'],
  args: { height: 420 },
  play: async ({ canvasElement }) => {
    // One run per language rather than one long one: a failure then names the
    // language, and a run of a dozen cells does not accumulate enough
    // sub-pixel rounding to blur the "one character, one cell" check.
    for (const [language, payload] of DIACRITICS_LANGUAGES) {
      const chars = Array.from(payload);
      const rect = await typeRun(canvasElement, payload, chars.map(plain));
      try {
        expectPainted(canvasElement, rect, chars.length + 2);
      } catch (error) {
        throw new Error(`${language} (${payload}): ${(error as Error).message}`);
      }
      press({ key: 'Enter' });
    }
  },
};
