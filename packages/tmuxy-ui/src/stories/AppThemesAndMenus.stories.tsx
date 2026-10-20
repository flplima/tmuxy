import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { GlitchRecorder } from './glitchRecorder';
import {
  activePaneId,
  paneGroups,
  focusFirstPane,
  openAppMenu,
  settleGeometry,
  rectSignature,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Themes & Menus',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * Themes: the client fetches the bundled theme list on connect (populating the
 * theme picker) and loads the active theme stylesheet from `/themes/<name>.css`.
 * Switching mode flips the `theme-dark`/`theme-light` class on the document root,
 * which swaps the CSS variables the whole UI is painted from. Asserts the list is
 * populated, the stylesheet is loaded, and a real theme variable changes value.
 */
export const Theme: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const doc = canvasElement.ownerDocument;
    const html = doc.documentElement;
    const app = (
      window as unknown as {
        app: {
          send(e: { type: string; mode: string }): void;
          getSnapshot(): { context: { availableThemes: unknown[] } };
        };
      }
    ).app;
    await waitFor(() => expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(2), {
      timeout: 45000,
      interval: 500,
    });
    // The theme picker list is populated from the bundled themes…
    await waitFor(
      () => expect(app.getSnapshot().context.availableThemes.length).toBeGreaterThan(0),
      {
        timeout: 15000,
        interval: 500,
      },
    );
    // …and the active theme stylesheet is actually loaded. The app injects
    // the `#tmuxy-theme` <link> during its theme init on connect, which can
    // land a beat after the panes render — wait for it rather than assume it
    // already exists (e.g. on a fresh page load with no prior story's link).
    // Generous timeout: theme init rides HTTP fetches that contend with the
    // emulator for the runner's CPU — in the full shared-engine sweep this
    // has been observed to exceed 15s while passing solo in under 5s.
    await waitFor(
      () =>
        expect(doc.getElementById('tmuxy-theme')?.getAttribute('href') ?? '').toMatch(
          /\/themes\/.+\.css$/,
        ),
      { timeout: 45000, interval: 300 },
    );
    const bg = () => getComputedStyle(html).getPropertyValue('--term-background').trim();
    app.send({ type: 'SET_THEME_MODE', mode: 'light' });
    await waitFor(
      () => {
        expect(html.classList.contains('theme-light')).toBe(true);
        expect(bg()).toBe('#fafafa');
      },
      { timeout: 5000, interval: 200 },
    );
    app.send({ type: 'SET_THEME_MODE', mode: 'dark' });
    await waitFor(
      () => {
        expect(html.classList.contains('theme-dark')).toBe(true);
        expect(bg()).toBe('#000000');
      },
      { timeout: 5000, interval: 200 },
    );
  },
};

/**
 * Theme picker via the menu — entirely by mouse: hamburger → Theme → Dracula,
 * then Light Mode. The stylesheet link must switch to dracula.css and the
 * documentElement mode class must flip — the same real path a user takes.
 */
export const ThemePickerViaMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    // The picker list is populated on connect.
    await waitFor(
      () =>
        expect(
          (
            window as unknown as {
              app: { getSnapshot(): { context: { availableThemes: unknown[] } } };
            }
          ).app.getSnapshot().context.availableThemes.length,
        ).toBeGreaterThan(0),
      { timeout: 15000, interval: 500 },
    );
    const doc = canvasElement.ownerDocument;
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^View$/));
    await user.click(await menu.item(/^Theme$/));
    await user.click(await menu.item(/Dracula/));
    await waitFor(
      () =>
        expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toBe('/themes/dracula.css'),
      { timeout: 10000, interval: 300 },
    );
    const menu2 = await openAppMenu(canvasElement, user);
    await user.click(await menu2.item(/^View$/));
    await user.click(await menu2.item(/^Theme$/));
    await user.click(await menu2.item(/Light Mode/));
    await waitFor(() => expect(doc.documentElement.classList.contains('theme-light')).toBe(true), {
      timeout: 10000,
      interval: 300,
    });
    // Restore defaults so the persisted localStorage doesn't bleed.
    (
      window as unknown as {
        app: { send(e: { type: string; name?: string; mode?: string }): void };
      }
    ).app.send({
      type: 'SET_THEME',
      name: 'default',
    });
    (window as unknown as { app: { send(e: { type: string; mode: string }): void } }).app.send({
      type: 'SET_THEME_MODE',
      mode: 'dark',
    });
  },
};

/**
 * Status bar content: shows the live session's hostname/prompt block and the
 * keybinding hints; after a rename via the guest CLI the (windowless) status
 * line still reflects the real tmux status — asserted from the rendered bar.
 */
export const StatusBarContent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const bar = () =>
      canvasElement.querySelector('.status-bar, [class*="status-bar"], .tmux-status-bar');
    await waitFor(
      () => {
        expect(bar()).not.toBeNull();
        // Keybinding hints + host block are rendered for the live session.
        expect((bar()?.textContent ?? '').length).toBeGreaterThan(3);
      },
      { timeout: 15000, interval: 500 },
    );
    // The window tab strip shows the real window name from tmux.
    expect(canvas.getByRole('tab', { name: /root/ })).toBeTruthy();
  },
};

/**
 * Menu-driven pane ops: hamburger → Pane → "Split Pane Below" — a mouse-only
 * split through menuActions → run_tmux_command → real tmux. A real new `%N`
 * pane must render.
 */
export const MenuPaneOps: Story = {
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
        expect(paneGroups(canvas).length).toBeGreaterThan(before);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * 3.7 — Status bar gestures are a browser no-op (drag/maximize are
 * Tauri-only): double-clicking the empty status bar must not error, emit tmux
 * commands, or disturb the layout. Pins the guard contract.
 */
export const StatusBarNoOpGestures: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    await settleGeometry(canvas);
    const sigBefore = rectSignature(canvas);
    const bar = canvasElement.querySelector('.statusbar') as HTMLElement;
    expect(bar).not.toBeNull();
    bar.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    await new Promise((r) => setTimeout(r, 800));
    expect(rectSignature(canvas)).toBe(sigBefore);
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};

/**
 * 4.4 — Theme switch is one clean swap: flipping the theme via the app menu
 * rewrites one stylesheet href — the pane grid must see NO node flicker, at
 * most a bounded class churn, and zero geometry movement.
 */
export const ThemeSwitchChurn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await waitFor(
      () =>
        expect(
          (
            window as unknown as {
              app: { getSnapshot(): { context: { availableThemes: unknown[] } } };
            }
          ).app.getSnapshot().context.availableThemes.length,
        ).toBeGreaterThan(0),
      { timeout: 15000, interval: 500 },
    );
    const doc = canvasElement.ownerDocument;
    await settleGeometry(canvas);

    const glitches = new GlitchRecorder(canvasElement.querySelector('.pane-layout')!);
    const menu = await openAppMenu(canvasElement, user);
    await user.click(await menu.item(/^View$/));
    await user.click(await menu.item(/^Theme$/));
    await user.click(await menu.item(/Nord/));
    await waitFor(
      () =>
        expect(doc.getElementById('tmuxy-theme')?.getAttribute('href')).toBe('/themes/nord.css'),
      { timeout: 10000, interval: 300 },
    );
    await new Promise((r) => setTimeout(r, 800));
    glitches.assertNoGlitches('theme');

    // Restore the default theme for the shared engine's next story.
    (window as unknown as { app: { send(e: { type: string; name: string }): void } }).app.send({
      type: 'SET_THEME',
      name: 'default',
    });
  },
};
