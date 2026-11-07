/**
 * Blinking cursor, over a pane recorded from real tmux. What the user sees is
 * the SmoothCursor overlay, so the blink rides on its own layer
 * (`.smooth-cursor-blink`): the glide rewrites the overlay's and the glyph's
 * opacity on every frame. It winks only when `@tmuxy-cursor-blink` (View >
 * Blinking Cursor) and the application's DECSCUSR request agree; shapes 2, 4
 * and 6 ask for a steady cursor. The assertions sample the painted opacity,
 * not a class.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import { APPEARANCE } from './animationStoryHelpers';
import { storyApp } from './storyApp';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Cursor Blink',
  component: FixtureApp,
  args: { fixture: asFixture(panes), start: 'one' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The `@tmuxy-cursor-blink` switch, the DECSCUSR shape that can override it, and the View menu item that flips it — checked against the opacity the overlay actually paints.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

function appContainer(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.app-container');
  if (!el) throw new Error('.app-container not found');
  return el;
}

async function blinkLayer(canvasElement: HTMLElement): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = canvasElement.querySelector<HTMLElement>('.smooth-cursor-blink');
      if (!el) throw new Error('no .smooth-cursor-blink yet');
      const root = el.parentElement as HTMLElement;
      expect(root.style.opacity).toBe('1');
      return el;
    },
    { timeout: 8000 },
  );
}

/**
 * Samples the layer's painted opacity across a little over one blink period:
 * a blinking cursor is fully off for half of it, a steady one never leaves 1.
 */
async function sampleOpacity(el: HTMLElement, ms = 1300): Promise<number[]> {
  const seen: number[] = [];
  const until = performance.now() + ms;
  while (performance.now() < until) {
    seen.push(Number(getComputedStyle(el).opacity));
    await new Promise((r) => setTimeout(r, 40));
  }
  return seen;
}

const pushAppearance = (blink: boolean) =>
  storyApp().send({
    type: 'THEME_SETTINGS_RECEIVED',
    theme: 'default',
    mode: 'dark',
    appearance: { ...APPEARANCE, cursorBlink: blink },
  });

export const BlinksByDefault: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'With no `@tmuxy-cursor-blink` in the config the default is on, so the app container carries `.app-cursor-blink` and a default-shape cursor (DECSCUSR 0) blinks. Sampling the blink layer over one period sees full opacity and full transparency, which is the hard on/off a terminal caret has rather than a fade.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });

    expect(appContainer(canvasElement).classList.contains('app-cursor-blink')).toBe(true);
    const layer = await blinkLayer(canvasElement);
    const root = layer.parentElement as HTMLElement;
    await waitFor(() => expect(root.classList.contains('is-blinking')).toBe(true));
    expect(layer.getAnimations().length).toBeGreaterThan(0);

    const seen = await sampleOpacity(layer);
    expect(Math.max(...seen)).toBe(1);
    expect(Math.min(...seen)).toBe(0);
  },
};

export const ViewMenuTogglesTheBlink: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          '`set -g @tmuxy-cursor-blink off` reaches the client with the appearance (THEME_SETTINGS_RECEIVED): the gate class comes off the app container, the animation stops, and the cursor stays painted for a full period; turning it back on (a `source-file` re-push) starts it winking again. The View submenu carries the same switch as a checked "Blinking Cursor" item. Clicking it flips the gate class straight away and sends `set_cursor_blink` to the backend, which writes the choice back to the tmuxy config so it survives a restart. Re-opening the menu shows the box unchecked.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const layer = await blinkLayer(canvasElement);
    const container = appContainer(canvasElement);
    expect(container.classList.contains('app-cursor-blink')).toBe(true);

    pushAppearance(false);
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(false));
    expect(layer.getAnimations().length).toBe(0);
    const seen = await sampleOpacity(layer);
    expect(Math.min(...seen)).toBe(1);

    pushAppearance(true);
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(true));
    expect(layer.getAnimations().length).toBeGreaterThan(0);

    // The menu portals to document.body. The status bar's hamburger shares its
    // accessible name with every pane header's menu button.
    const body = within(document.body);
    const hamburger = canvasElement.querySelector<HTMLElement>('.app-menu-button');
    if (!hamburger) throw new Error('.app-menu-button not found');
    await userEvent.click(hamburger);
    await userEvent.click(await body.findByRole('menuitem', { name: 'View' }));
    const item = await body.findByRole('menuitemcheckbox', { name: /blinking cursor/i });
    expect(item).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(item);
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(false));
    expect(layer.getAnimations().length).toBe(0);

    await userEvent.click(hamburger);
    await userEvent.click(await body.findByRole('menuitem', { name: 'View' }));
    const again = await body.findByRole('menuitemcheckbox', { name: /blinking cursor/i });
    expect(again).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(again);
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(true));
  },
};
