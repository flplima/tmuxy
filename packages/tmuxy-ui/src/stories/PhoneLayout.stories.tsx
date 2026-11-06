/**
 * The phone layout, at a 390 × 844 phone's width, over a recording of real
 * tmux at the 80 × 24 grid the layout asks for.
 *
 * The whole 80 × 25 terminal at the top, 80 columns spanning the screen edge
 * to edge with tmux's status line as the 25th row, then the key row, then the
 * bottom view — the tab/pane tree to begin with — over a tab bar that picks
 * the menu, the tree or the side pane. No tab strip. The frame is not the
 * viewport the media query reads, so the story asks for the layout through
 * the config.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx, tapAt } from './phoneStoryHelpers';
import { PHONE_STATUS_HEIGHT } from '../utils/phoneLayout';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Layout',
  component: FixtureApp,
  args: {
    fixture: asFixture(phoneTwoTabs),
    start: 'main-active',
    config: { phoneLayout: true },
  },
  // The phone's screen, not the grid's box: the layout fits the grid to it.
  render: ({ fixture, start, config }) => (
    <FixtureProvider fixture={fixture} start={start} config={config} width={390} height={844}>
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

export const PhoneKeyboardDown: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'No tab strip: the terminal is at the top of the screen, and the tree under the keys lists the tabs. The terminal is asked for at 80 × 24 and drawn at the cell that fits 80 columns across the screen, edge to edge; tmux’s line sits under it as row 25, as wide. ctrl latches on one tap, locks on a second and lets go on a third; the tree lists both tabs below the keys.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.pane-layout-item')).not.toBeNull();
      },
      { timeout: 8000 },
    );

    // No bottom bar of the app's own.
    expect(canvasElement.querySelectorAll('.tmux-status-bar')).toHaveLength(1);

    // No tab strip: the terminal starts at the top of the screen.
    expect(canvasElement.querySelector('.phone-tab-strip')).toBeNull();
    expect(box(canvasElement.querySelector('.phone-pty')).top).toBeCloseTo(
      box(canvasElement.querySelector('.app-container')).top,
      0,
    );

    // 80 columns asked for, and 80 columns span the screen less 4px of
    // padding each side (the grid's outer borders), the status line under
    // them the screen's width.
    await waitFor(
      () => {
        expect(ctx().targetCols).toBe(80);
        expect(ctx().targetRows).toBe(24);
        // The phone's screen: the app's own box, not the story frame around it.
        const screen = box(canvasElement.querySelector('.app-container'));
        const layout = box(canvasElement.querySelector('.phone-pty .pane-layout'));
        expect(80 * ctx().charWidth).toBeCloseTo(screen.width - 8, 1);
        expect(layout.left).toBeCloseTo(screen.left + 4, 1);
        expect(layout.width).toBeCloseTo(screen.width - 8, 1);
        const item = box(canvasElement.querySelector('.phone-pty .pane-layout-item'));
        expect(item.left).toBeGreaterThanOrEqual(screen.left);
        expect(item.right).toBeLessThanOrEqual(screen.right);
        const line = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
        expect(line.left).toBeCloseTo(screen.left, 1);
        expect(line.width).toBeCloseTo(screen.width, 1);
        expect(line.height).toBe(PHONE_STATUS_HEIGHT);
      },
      { timeout: 8000 },
    );

    // Top to bottom: the grid, the status line as its last row, the keys,
    // the tree, and the tab bar under it, which reaches the screen's bottom.
    const grid = box(canvasElement.querySelector('.phone-pty .pane-container'));
    const status = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
    const keys = box(canvasElement.querySelector('.key-row'));
    const tree = box(canvasElement.querySelector('.phone-tree'));
    const tabBar = box(canvasElement.querySelector('.phone-tabs'));
    expect(status.top).toBeGreaterThanOrEqual(grid.bottom - 1);
    expect(keys.top).toBeGreaterThanOrEqual(status.bottom - 1);
    expect(tree.top).toBeGreaterThanOrEqual(keys.bottom - 1);
    expect(tree.height).toBeGreaterThan(100);
    expect(tabBar.top).toBeGreaterThanOrEqual(tree.bottom - 1);
    expect(tabBar.bottom).toBeCloseTo(box(canvasElement.querySelector('.app-container')).bottom, 0);
    // The tree is the chrome's size, not the terminal's shrunken one.
    const row = canvasElement.querySelector('.phone-tree [role="treeitem"]');
    expect(row).not.toBeNull();
    expect(parseFloat(getComputedStyle(row!).fontSize)).toBeGreaterThanOrEqual(11);

    // The desktop's line: the hints at its left edge, the host beside the
    // session at its right, all of it on the screen — the hints are written
    // for 80 columns, and the line is drawn in the small type at the phone's
    // cell, on a row just tall enough for it.
    const screenBox = box(canvasElement.querySelector('.app-container'));
    const hints = box(canvasElement.querySelector('.phone-pty .statusline-hints'));
    const host = box(canvasElement.querySelector('.phone-pty .statusline-host'));
    const session = box(canvasElement.querySelector('.phone-pty .statusline-session'));
    expect(hints.width).toBeGreaterThan(0);
    expect(hints.left - screenBox.left).toBeLessThan(8);
    expect(host.left).toBeGreaterThan(hints.right);
    expect(session.left).toBeGreaterThanOrEqual(host.right);
    expect(session.right).toBeLessThanOrEqual(screenBox.right + 0.5);
    expect(session.right).toBeGreaterThan(screenBox.right - 8);
    expect(host.height).toBe(PHONE_STATUS_HEIGHT);
    const smallType = (sel: string) =>
      parseFloat(getComputedStyle(canvasElement.querySelector(sel)!).fontSize);
    const termType = parseFloat(
      getComputedStyle(canvasElement.querySelector('.phone-pty')!).getPropertyValue(
        '--tmuxy-font-size',
      ),
    );
    expect(smallType('.phone-pty .statusline-hints')).toBeCloseTo(termType * 0.8, 1);
    expect(smallType('.phone-pty .statusline-host')).toBeCloseTo(termType * 0.8, 1);

    // Two rows of six, every key the same width: esc, tab, ctrl, alt, the
    // prefix and the keyboard; the arrows, enter and the zoom. Each a
    // thumb's size.
    const keyboxes = [...canvasElement.querySelectorAll('.key-row-key')].map(box);
    expect(keyboxes).toHaveLength(12);
    expect(keyboxes.every((k) => k.height >= 40 && k.width >= 50)).toBe(true);
    expect(keyboxes.every((k) => Math.abs(k.width - keyboxes[0].width) < 1)).toBe(true);
    const rowTops = [...new Set(keyboxes.map((k) => Math.round(k.top)))];
    expect(rowTops).toHaveLength(2);
    expect(keyboxes.filter((k) => Math.round(k.top) === rowTops[0])).toHaveLength(6);
    const keyAt = (label: string) => box(canvasElement.querySelector(`[data-key-row="${label}"]`));
    expect(keyAt('⌨').top).toBeCloseTo(keyAt('esc').top, 0);
    expect(keyAt('←').top).toBeGreaterThanOrEqual(keyAt('esc').bottom);
    expect(keyAt('⏎').top).toBeCloseTo(keyAt('←').top, 0);
    expect(keyAt('zoom').top).toBeCloseTo(keyAt('←').top, 0);
    expect(keyAt('zoom').left).toBeGreaterThan(keyAt('⏎').left);
    // The zoom key is a magnifier, not a glyph.
    expect(canvasElement.querySelector('[data-key-row="zoom"] svg circle')).not.toBeNull();

    // ctrl: latched, locked, off.
    const ctrl = canvasElement.querySelector('[data-key-row="ctrl"]') as HTMLElement;
    await userEvent.click(ctrl);
    expect(ctrl.getAttribute('aria-pressed')).toBe('true');
    expect(ctrl.className).toContain('is-latched');
    expect(getComputedStyle(ctrl).backgroundColor).not.toBe(
      getComputedStyle(canvasElement.querySelector('[data-key-row="esc"]')!).backgroundColor,
    );
    await userEvent.click(ctrl);
    expect(ctrl.className).toContain('is-locked');
    await userEvent.click(ctrl);
    expect(ctrl.getAttribute('aria-pressed')).toBe('false');

    // A latch lets go after the next key.
    await userEvent.click(ctrl);
    await userEvent.click(canvasElement.querySelector('[data-key-row="⏎"]') as HTMLElement);
    expect(ctrl.getAttribute('aria-pressed')).toBe('false');
  },
};

export const LandscapeAndTheKeyboard: Story = {
  // The phone turned sideways: 844 × 390.
  render: ({ fixture, start, config }) => (
    <FixtureProvider fixture={fixture} start={start} config={config} width={844} height={390}>
      <TmuxyApp />
    </FixtureProvider>
  ),
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 390 },
      description: {
        story:
          'Held sideways, the terminal takes the right of the screen at the height that fits its 24 rows and tmux’s line, and the tab strip, the keys and the bottom view stack in the column left of it. A keyboard coming up leaves the type as it was: the terminal is cut short and scrolled to keep the cursor’s row in view, the keys stay above the keyboard.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLandscape).toBe(true);
        expect(canvasElement.querySelector('.phone-side .key-row')).not.toBeNull();
        expect(canvasElement.querySelector('.phone-pty .pane-layout-item')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const screen = box(canvasElement.querySelector('.app-container'));
    const side = box(canvasElement.querySelector('.phone-side'));
    const pty = box(canvasElement.querySelector('.phone-pty'));

    // The chrome on the left, the terminal on the right, both the screen's height.
    expect(side.left).toBeCloseTo(screen.left, 0);
    expect(pty.right).toBeCloseTo(screen.right, 0);
    expect(side.right).toBeLessThanOrEqual(pty.left + 1);
    expect(pty.width).toBeCloseTo(80 * ctx().charWidth + 8, 0);
    expect(side.width).toBeGreaterThanOrEqual(299);
    for (const part of ['.key-row', '.phone-tree']) {
      expect(box(canvasElement.querySelector(`.phone-side ${part}`)).width).toBeGreaterThan(0);
    }
    // All 24 rows and tmux's line on screen: the line ends inside it.
    const line = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
    expect(line.bottom).toBeLessThanOrEqual(screen.bottom + 0.5);
    expect(line.bottom).toBeGreaterThan(screen.bottom - 25);

    // The keyboard comes up: the screen is 190px tall.
    const rowHeight = ctx().charHeight;
    const frame = canvasElement.querySelector('.app-container')!.parentElement as HTMLElement;
    frame.style.height = '190px';
    await waitFor(
      () => {
        const term = canvasElement.querySelector('.phone-pty') as HTMLElement;
        expect(box(term).height).toBeLessThanOrEqual(190.5);
        expect(term.scrollHeight).toBeGreaterThan(term.clientHeight);
        const cursor = box(canvasElement.querySelector('.phone-pty .terminal-cursor'));
        expect(cursor.top).toBeGreaterThanOrEqual(box(term).top - 0.5);
        expect(cursor.bottom).toBeLessThanOrEqual(box(term).bottom + 0.5);
      },
      { timeout: 5000 },
    );
    expect(ctx().charHeight).toBe(rowHeight);
    expect(box(canvasElement.querySelector('.key-row')).bottom).toBeLessThanOrEqual(
      box(frame).bottom + 0.5,
    );
  },
};

export const DoubleTapZoomsTheTerminal: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'A double tap on the terminal draws it at twice its size in a viewport that scrolls, around the point tapped — the browser’s zoom, not tmux’s: the window stays 80 × 24 and the cell measurement is untouched. The key row’s zoom key lights while it is on, and puts it back.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLayout).toBe(true);
        expect(canvasElement.querySelector('.pane-active [role="log"]')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const log = canvasElement.querySelector('.pane-active [role="log"]')!;
    const grid = box(canvasElement.querySelector('.phone-pty .pane-container'));
    const viewport = canvasElement.querySelector('.phone-zoom-viewport') as HTMLElement;
    const zoomKey = canvasElement.querySelector('[data-key-row="zoom"]') as HTMLElement;
    const at = { x: grid.left + grid.width / 2, y: grid.top + grid.height / 2 };

    tapAt(log, at.x, at.y);
    tapAt(log, at.x + 2, at.y + 2);
    await waitFor(() => {
      expect(canvasElement.querySelector('.phone-pty.is-zoomed')).not.toBeNull();
      expect(box(canvasElement.querySelector('.phone-pty .pane-container')).width).toBeCloseTo(
        grid.width * 2,
        0,
      );
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth + 10);
      expect(viewport.scrollLeft).toBeGreaterThan(50);
      expect(zoomKey.getAttribute('aria-pressed')).toBe('true');
    });
    expect(ctx().targetCols).toBe(80);
    // The viewport itself keeps the grid's unzoomed size.
    expect(box(viewport).width).toBeCloseTo(grid.width, 0);

    await userEvent.click(zoomKey);
    await waitFor(() => {
      expect(canvasElement.querySelector('.phone-pty.is-zoomed')).toBeNull();
      expect(box(canvasElement.querySelector('.phone-pty .pane-container')).width).toBeCloseTo(
        grid.width,
        0,
      );
      expect(viewport.scrollLeft).toBe(0);
    });
  },
};

export const PrefixKeyArmed: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'The prefix key on the key row arms tmux’s prefix with one tap and is lit in the accent while it waits for the next key, as the desktop status bar’s chip is. A second tap cancels it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(ctx().phoneLayout).toBe(true), { timeout: 8000 });
    const key = await waitFor(
      () => {
        const el = canvasElement.querySelector('[data-key-row="prefix"]') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 8000 },
    );
    const row = box(canvasElement.querySelector('.key-row'));
    const at = box(key);
    expect(at.width).toBeGreaterThan(0);
    expect(at.left).toBeGreaterThanOrEqual(row.left);
    expect(at.right).toBeLessThanOrEqual(Math.min(row.right, window.innerWidth));
    expect(key.getAttribute('aria-label')).toBe('Prefix (C-a)');
    expect(key.getAttribute('aria-pressed')).toBe('false');
    const dark = getComputedStyle(key).backgroundColor;

    await userEvent.click(key);
    await waitFor(() => expect(key.getAttribute('aria-pressed')).toBe('true'), { timeout: 5000 });
    expect(getComputedStyle(key).backgroundColor).not.toBe(dark);
    // Lit the way a latched ctrl is: the same accent.
    const ctrl = canvasElement.querySelector('[data-key-row="ctrl"]') as HTMLElement;
    await userEvent.click(ctrl);
    await waitFor(() => expect(ctrl.getAttribute('aria-pressed')).toBe('true'), { timeout: 5000 });
    expect(getComputedStyle(key).backgroundColor).toBe(getComputedStyle(ctrl).backgroundColor);
    await userEvent.click(ctrl);
    await userEvent.click(ctrl);

    await userEvent.click(key);
    await waitFor(() => expect(key.getAttribute('aria-pressed')).toBe('false'), { timeout: 5000 });
    expect(getComputedStyle(key).backgroundColor).toBe(dark);
  },
};
