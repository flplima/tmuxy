/**
 * International keyboard input: the focus an IME needs to compose at all.
 *
 * Which keydown a layout sends — a dead key's finished character stamped
 * keyCode 229, a macOS Option character, an AltGr third-level symbol, a
 * composition's commit — and how keyboardActor turns it into text exactly
 * once is unit-tested (`keyboardActor.ime.test.ts`); that the text reaches
 * the shell through real tmux is E2E (`1-input-interaction`, Scenario 2c, and
 * `11-webkit` for a click into the pane). What only the whole app in a
 * browser shows is where browser focus sits once a pane exists, and that
 * text typed there lands in that pane.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import hangulTyped from './fixtures/gen/hangul-typed.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/International Input',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/**
 * A text key as the browser delivers it to a focused input: the keydown, then
 * — unless the app took the key — the `input` event that carries the text.
 */
function press(key: string): void {
  const target = document.activeElement ?? window;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  if (!event.defaultPrevented && target instanceof HTMLInputElement) {
    target.value = key;
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: key, inputType: 'insertText' }),
    );
  }
}

/**
 * An IME committing `text`: the suppressed keys of the composition, its
 * `compositionend`, and the `input` Chrome fires after the commit.
 */
function compose(text: string): void {
  const target = document.activeElement ?? window;
  target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  for (const key of text) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, keyCode: 229, isComposing: true, bubbles: true }),
    );
  }
  target.dispatchEvent(new CompositionEvent('compositionend', { data: text, bubbles: true }));
  if (target instanceof HTMLInputElement) {
    target.value = text;
    target.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
    );
  }
}

/** The pane's prompt row, read as painted (trailing blanks are not). */
function promptLine(canvasElement: HTMLElement): HTMLElement {
  const line = [...canvasElement.querySelectorAll<HTMLElement>('.terminal-line')]
    .filter((l) => (l.textContent ?? '').startsWith('$'))
    .pop();
  if (!line) throw new Error('no prompt line rendered yet');
  return line;
}

/** Box of `text` where it is painted on `line`, by character offset. */
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

/**
 * Where an IME composes. A composition can only begin inside an editable
 * element, and until PR #61 nothing on the desktop ever had one — the hidden
 * input existed for touch keyboards only, so Korean, Japanese and Chinese
 * input had nowhere to start. Now the input takes browser focus as soon as a
 * pane exists and follows the pane holding the keyboard: a composition
 * committed there, and plain keys after it, reach that pane and are painted
 * in it.
 */
export const HiddenInputOwnsFocus: Story = {
  args: {
    fixture: asFixture(hangulTyped),
    start: 'one',
    transitions: [
      { match: /^send-keys -t %0 -l -- '한글'$/, to: 'hangul' },
      { match: /^send-keys -t %0 -l -- 'b'$/, to: 'hangul-ab' },
    ],
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(promptLine(canvasElement)).toBeTruthy(), { timeout: 15000 });
    await waitFor(() => expect(document.activeElement?.tagName).toBe('INPUT'));

    compose('한글');
    await waitFor(() =>
      expect((promptLine(canvasElement).textContent ?? '').replace(/\s+/g, '')).toContain('$한글'),
    );

    press('a');
    press('b');
    await waitFor(() =>
      expect((promptLine(canvasElement).textContent ?? '').replace(/\s+/g, '')).toContain(
        '$한글ab',
      ),
    );

    // Painted inside the pane, one cell per narrow character.
    const pane = canvasElement.querySelector<HTMLElement>('[data-pane-id="%0"]')!;
    const paneBox = pane.getBoundingClientRect();
    const box = runRect(promptLine(canvasElement), 'ab');
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(paneBox.left - 1);
    expect(box.right).toBeLessThanOrEqual(paneBox.right + 1);
    expect(box.top).toBeGreaterThanOrEqual(paneBox.top - 1);
    expect(box.bottom).toBeLessThanOrEqual(paneBox.bottom + 1);
    const cell = parseFloat(getComputedStyle(pane).getPropertyValue('--cell-w'));
    expect(box.width / cell).toBeCloseTo(2, 0);
  },
};
