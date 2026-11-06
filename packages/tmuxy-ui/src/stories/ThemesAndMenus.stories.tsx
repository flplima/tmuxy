import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import { GlitchRecorder } from './glitchRecorder';
import {
  activePaneId,
  paneGroups,
  focusFirstPane,
  openAppMenu,
  settleGeometry,
  rectSignature,
} from './appStoryHelpers';

/**
 * The app menu's theme and pane items, and the status bar's gestures, over
 * two panes recorded from real tmux (`fixtures/scenarios/panes.ts`).
 */
const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Themes & Menus',
  component: FixtureApp,
  args: { fixture: asFixture(panes), start: 'side-by-side' },
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

type ThemeApp = {
  send(e: { type: string; name?: string; mode?: string }): void;
  getSnapshot(): { context: { availableThemes: unknown[] } };
};
const app = () => (window as unknown as { app: ThemeApp }).app;

async function waitForThemeList() {
  await waitFor(
    () => expect(app().getSnapshot().context.availableThemes.length).toBeGreaterThan(0),
    {
      timeout: 10000,
      interval: 200,
    },
  );
}

/** Back to the default theme in dark mode, which the next story expects. */
function restoreDefaultTheme() {
  app().send({ type: 'SET_THEME', name: 'default' });
  app().send({ type: 'SET_THEME_MODE', mode: 'dark' });
}

/**
 * Hamburger → View → Theme → Dracula, then Light Mode, by mouse: the
 * stylesheet link, the root's mode class and a theme variable all change.
 */
export const ThemePickerViaMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitForThemeList();
    const doc = canvasElement.ownerDocument;
    const html = doc.documentElement;
    const bg = () => getComputedStyle(html).getPropertyValue('--term-background').trim();
    try {
      const menu = await openAppMenu(canvasElement, user);
      await user.click(await menu.item(/^View$/));
      await user.click(await menu.item(/^Theme$/));
      await user.click(await menu.item(/Dracula/));
      await waitFor(
        () =>
          expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toBe(
            '/themes/dracula.css',
          ),
        { timeout: 10000, interval: 200 },
      );
      await waitFor(() => expect(html.classList.contains('theme-dark')).toBe(true), {
        timeout: 10000,
        interval: 200,
      });
      await waitFor(() => expect(bg()).not.toBe(''), { timeout: 10000, interval: 200 });
      const darkBg = bg();

      const menu2 = await openAppMenu(canvasElement, user);
      await user.click(await menu2.item(/^View$/));
      await user.click(await menu2.item(/^Theme$/));
      await user.click(await menu2.item(/Light Mode/));
      await waitFor(
        () => {
          expect(html.classList.contains('theme-light')).toBe(true);
          expect(bg()).not.toBe(darkBg);
        },
        { timeout: 10000, interval: 200 },
      );
    } finally {
      restoreDefaultTheme();
    }
  },
};

/** Hamburger → Pane → "Split Pane Below", answered with the pane tmux split below. */
export const MenuPaneOps: Story = {
  args: { transitions: [{ match: /^split-window -v$/, to: 'three' }] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = paneGroups(canvas).length;
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^Pane$/));
    await user.click(await menu.item(/Split Pane Below/));
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBe(before + 1);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 10000, interval: 200 },
    );
  },
};

let adapter: FixtureAdapter | null = null;
function keepAdapter(a: FixtureAdapter) {
  adapter = a;
}

/**
 * Status bar drag and maximize are Tauri-only: in a browser, pressing and
 * double-clicking the empty status bar sends tmux nothing.
 */
export const StatusBarNoOpGestures: Story = {
  render: (args) => <FixtureApp {...args} onAdapterReady={keepAdapter} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const sigBefore = rectSignature(canvas);
    const sentBefore = adapter!.commands.length;
    const bar = canvasElement.querySelector('.statusbar') as HTMLElement;
    expect(bar).not.toBeNull();
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await new Promise((r) => setTimeout(r, 800));
    expect(rectSignature(canvas)).toBe(sigBefore);
    expect(adapter!.commands.slice(sentBefore)).toEqual([]);
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};

/**
 * A theme switch rewrites one stylesheet href: no node flicker in the pane
 * grid, bounded class churn, no geometry movement.
 */
export const ThemeSwitchChurn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitForThemeList();
    const doc = canvasElement.ownerDocument;
    await settleGeometry(canvas);
    try {
      const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
      const menu = await openAppMenu(canvasElement, user);
      await user.click(await menu.item(/^View$/));
      await user.click(await menu.item(/^Theme$/));
      await user.click(await menu.item(/Nord/));
      await waitFor(
        () =>
          expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toBe('/themes/nord.css'),
        { timeout: 10000, interval: 200 },
      );
      await new Promise((r) => setTimeout(r, 800));
      glitches.assertNoGlitches('theme');
    } finally {
      restoreDefaultTheme();
    }
  },
};
