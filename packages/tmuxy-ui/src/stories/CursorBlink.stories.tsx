/**
 * Blinking cursor stories (demo engine).
 *
 * What the user sees is the SmoothCursor overlay, not the pane's own cursor
 * element — that one is only the anchor the overlay glides to. So the blink
 * rides on a layer of its own inside the overlay (`.smooth-cursor-blink`),
 * because the glide rewrites the overlay root's and the glyph's opacity on
 * every frame.
 *
 * Two switches have to agree before anything winks:
 *
 *  - `@tmuxy-cursor-blink` from tmuxy.conf, carried in the appearance and put
 *    on the app container as `.app-cursor-blink`. View > Blinking Cursor flips
 *    it and the choice is written back to the config.
 *  - the running application's DECSCUSR request, mirrored onto the anchor as
 *    `.terminal-cursor-blink` and onto the overlay as `.is-blinking`. Shapes
 *    2, 4 and 6 ask for a steady cursor and get one either way.
 *
 * The assertions watch the real thing: a sampled `opacity` that actually
 * reaches 0 and comes back, not just the presence of a class.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Cursor Blink',
  component: AppHarness,
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
type Story = StoryObj<typeof AppHarness>;

const APPEARANCE = {
  opacity: 0.7,
  activePaneOpacity: 1,
  inactivePaneOpacity: 0.7,
  activeTextOpacity: 1,
  inactiveTextOpacity: 0.7,
  blur: false,
  animations: true,
};

interface AppActor {
  send: (event: unknown) => void;
}

function getApp(): AppActor {
  const app = (window as unknown as { app?: AppActor }).app;
  if (!app) throw new Error('window.app actor is not available — AppHarness not mounted?');
  return app;
}

function appContainer(canvasElement: HTMLElement): HTMLElement {
  const el = canvasElement.querySelector<HTMLElement>('.app-container');
  if (!el) throw new Error('.app-container not found');
  return el;
}

/** The overlay layer the blink animates, once the cursor has found its pane. */
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
 * Sample the layer's painted opacity across a little over one blink period.
 * A blinking cursor is fully on for half of it and fully off for the other
 * half; a steady one never leaves 1.
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

// ---------------------------------------------------------------------------
// On by default — the cursor winks out and comes back
// ---------------------------------------------------------------------------

export const BlinksByDefault: Story = {
  args: { height: 400 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 400 },
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

// ---------------------------------------------------------------------------
// Config off — `@tmuxy-cursor-blink off` holds the cursor solid
// ---------------------------------------------------------------------------

export const ConfigBlinkOff: Story = {
  args: { height: 400 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 400 },
      description: {
        story:
          '`set -g @tmuxy-cursor-blink off` reaches the client with the appearance (THEME_SETTINGS_RECEIVED). The gate class comes off the app container, the animation stops, and the cursor stays painted for a full period. Turning it back on (a `source-file` re-push) starts it winking again.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const layer = await blinkLayer(canvasElement);
    const container = appContainer(canvasElement);

    getApp().send({
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...APPEARANCE, cursorBlink: false },
    });
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(false));
    expect(layer.getAnimations().length).toBe(0);

    const seen = await sampleOpacity(layer);
    expect(Math.min(...seen)).toBe(1);

    getApp().send({
      type: 'THEME_SETTINGS_RECEIVED',
      theme: 'default',
      mode: 'dark',
      appearance: { ...APPEARANCE, cursorBlink: true },
    });
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(true));
    expect(layer.getAnimations().length).toBeGreaterThan(0);
  },
};

// ---------------------------------------------------------------------------
// View > Blinking Cursor — the user path that flips it and writes the config
// ---------------------------------------------------------------------------

export const ViewMenuTogglesTheBlink: Story = {
  args: { height: 400 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 400 },
      description: {
        story:
          'The View submenu carries a checked "Blinking Cursor" item. Clicking it flips the gate class straight away and sends `set_cursor_blink` to the backend, which writes the choice back to the tmuxy config so it survives a restart. Re-opening the menu shows the box unchecked.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const container = appContainer(canvasElement);
    expect(container.classList.contains('app-cursor-blink')).toBe(true);

    // The menu portals to document.body, so query there once it is open. The
    // hamburger is the one in the status bar — each pane header has a menu
    // button of its own with the same accessible name.
    const body = within(document.body);
    const hamburger = canvasElement.querySelector<HTMLElement>('.app-menu-button');
    if (!hamburger) throw new Error('.app-menu-button not found');
    await userEvent.click(hamburger);
    await userEvent.click(await body.findByRole('menuitem', { name: 'View' }));
    const item = await body.findByRole('menuitemcheckbox', { name: /blinking cursor/i });
    expect(item).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(item);
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(false));
    const layer = canvasElement.querySelector<HTMLElement>('.smooth-cursor-blink');
    expect(layer!.getAnimations().length).toBe(0);

    await userEvent.click(hamburger);
    await userEvent.click(await body.findByRole('menuitem', { name: 'View' }));
    const again = await body.findByRole('menuitemcheckbox', { name: /blinking cursor/i });
    expect(again).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(again);
    await waitFor(() => expect(container.classList.contains('app-cursor-blink')).toBe(true));
  },
};
