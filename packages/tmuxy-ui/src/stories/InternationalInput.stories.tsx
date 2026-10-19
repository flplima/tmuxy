/**
 * International keyboard input (demo engine): what only a browser can show.
 *
 * Which keydown a layout sends — a dead key's finished character stamped
 * keyCode 229, a macOS Option character, an AltGr third-level symbol, a
 * composition's commit — and how keyboardActor turns it into text rather than
 * a chord is unit-tested (`keyboardActor.ime.test.ts`). These stories keep
 * what those tests cannot see: the cells the text paints and their boxes, and
 * the focus an IME needs to compose at all. Each types through the REAL chain
 * — a `keydown` or a composition, exactly as the browser fires it →
 * keyboardActor → `send-keys` → demo tmux → the shell's line editor → the
 * rendered grid.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import {
  cellWidth,
  compose,
  deadComposed,
  expectPainted,
  plain,
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
