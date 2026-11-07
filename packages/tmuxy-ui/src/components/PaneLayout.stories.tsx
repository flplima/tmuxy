/**
 * The active pane's outline means "the keyboard is in this pane": it leaves
 * while the tree, the dock or a float holds the keyboard, even though tmux's
 * active pane is unchanged.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { storyApp } from '../stories/storyApp';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';
import paneFocus from '../stories/fixtures/gen/pane-focus-tree.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Pane Layout',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const activeOutline = () => {
  const el = document.querySelector<HTMLElement>('.pane-layout-item.pane-active');
  return el ? getComputedStyle(el).outlineColor : null;
};

export const ActivePaneOutlineDefaultAndGruvbox: Story = {
  args: {
    fixture: asFixture(paneFocus),
    start: 'right-active',
    transitions: [
      { match: /^select-pane -t %0$/, to: 'left-active' },
      { match: /^split-window\b.*tmuxy-widget-tree'/, to: 'tree-open' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %1/i }, { timeout: 8000 });

    storyApp().send({ type: 'SET_THEME', name: 'default' });
    await waitFor(() => expect(activeOutline()).toBe('rgb(0, 205, 0)'), { timeout: 8000 });
    const inactivePane = () =>
      document.querySelector<HTMLElement>('.pane-layout-item.pane-inactive')!;
    expect(getComputedStyle(inactivePane()).outlineColor).not.toBe('rgb(0, 205, 0)');

    // Looked up at click time: the theme change above re-renders the layout,
    // and a node captured before it can be a replaced element.
    const before = storyApp().view().activePaneId;
    await userEvent.click(inactivePane().querySelector('[role="group"]')!);
    await waitFor(() => expect(storyApp().view().activePaneId).not.toBe(before), {
      timeout: 8000,
    });
    await waitFor(() => {
      const active = document.querySelector<HTMLElement>('.pane-layout-item.pane-active')!;
      expect(active.dataset.paneId ?? active.getAttribute('data-pane-id')).not.toBeNull();
      expect(getComputedStyle(active).outlineColor).toBe('rgb(0, 205, 0)');
    });

    // Gruvbox: its yellow accent (#d79921) rather than a green — the active
    // header's text shares it.
    storyApp().send({ type: 'SET_THEME', name: 'gruvbox' });
    await waitFor(() => expect(activeOutline()).toBe('rgb(215, 153, 33)'), { timeout: 8000 });

    // While the tree holds the keyboard (prefix s) no pane is green.
    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Control>}a{/Control}s');
    await waitFor(() => expect(document.querySelector('.sidebar-tree')).not.toBeNull(), {
      timeout: 8000,
    });
    await userEvent.click(document.querySelector('[data-testid="sidebar-content"]') as HTMLElement);
    await waitFor(
      () => expect(document.querySelector('.pane-layout-item.pane-active')).toBeNull(),
      {
        timeout: 8000,
      },
    );
    // `l` hands the keyboard back: the green returns.
    await user.keyboard('l');
    await waitFor(() => expect(activeOutline()).toBe('rgb(215, 153, 33)'), { timeout: 8000 });
  },
};

/**
 * A computed colour as 0–255 channels plus alpha. A `color-mix()` computes to
 * `color(srgb r g b / a)` with 0–1 channels rather than to `rgb()`.
 */
const colorOf = (value: string) => {
  const numbers = (value.match(/[\d.]+/g) ?? []).map(Number);
  const srgb = value.startsWith('color(srgb');
  const rgb = numbers.slice(0, 3).map((c) => (srgb ? c * 255 : c));
  return { rgb, alpha: numbers.length > 3 ? numbers[3] : 1 };
};

const resolve = (css: string) => {
  const probe = document.createElement('span');
  probe.style.color = css;
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return colorOf(color).rgb;
};

const near = (got: number[], want: number[]) =>
  got.every((channel, i) => Math.abs(channel - want[i]) <= 1);

const headers = () => {
  const bars = [...document.querySelectorAll<HTMLElement>('.pane-layout-item .pane-header')].map(
    (el) => colorOf(getComputedStyle(el).backgroundColor),
  );
  const title = document.querySelector<HTMLElement>(
    '.pane-layout-item.pane-active .pane-header .pane-tab-title',
  );
  return { bars, title: title ? colorOf(getComputedStyle(title).color) : null };
};

/**
 * A pane header's bar is the theme's gray — dark on a dark theme, light on a
 * light one — at 30%, on the background alone: the text on it stays solid.
 * Gruvbox writes everything on the active header in its yellow accent.
 */
export const PaneHeaderGrayAndGruvboxAccent: Story = {
  tags: ['nightly'],
  args: { fixture: asFixture(panes), start: 'side-by-side' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %1/i }, { timeout: 8000 });

    const expectBars = (gray: number[]) => {
      const { bars, title } = headers();
      expect(bars.length).toBe(2);
      for (const bar of bars) {
        expect(near(bar.rgb, gray)).toBe(true);
        expect(bar.alpha).toBeCloseTo(0.3, 2);
      }
      expect(title!.alpha).toBe(1);
      return title!;
    };

    storyApp().send({ type: 'SET_THEME', name: 'default' });
    storyApp().send({ type: 'SET_THEME_MODE', mode: 'dark' });
    await waitFor(() => expectBars(resolve('var(--border-medium)')), { timeout: 8000 });

    // Gruvbox's bg1.
    storyApp().send({ type: 'SET_THEME', name: 'gruvbox' });
    await waitFor(
      () => {
        const title = expectBars([0x3c, 0x38, 0x36]);
        expect(title.rgb).toEqual([215, 153, 33]);
      },
      { timeout: 8000 },
    );

    // Gruvbox, light: its light gray, and the accent — a darker yellow, so it
    // reads at 4.5:1 on the cream.
    storyApp().send({ type: 'SET_THEME_MODE', mode: 'light' });
    await waitFor(
      () => {
        const title = expectBars([0xd5, 0xc4, 0xa1]);
        expect(title.rgb).toEqual([0x8b, 0x5b, 0x0f]);
      },
      { timeout: 8000 },
    );
    storyApp().send({ type: 'SET_THEME_MODE', mode: 'dark' });
  },
};
