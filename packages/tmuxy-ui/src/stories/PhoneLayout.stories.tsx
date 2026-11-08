/**
 * The phone layout, at a 390 × 844 phone's width, over a recording of real
 * tmux at the 80 × 24 grid the layout asks for: upright, the terminal and
 * the keys over a bar a finger drags and the bottom view under its tab bar;
 * held sideways, the tree, the terminal and the side pane side by side over
 * one row of keys. The frame is not the viewport the media query reads, so
 * the story asks for the layout through the config.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { TmuxyApp } from '../lib';
import { FixtureApp, FixtureProvider } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import phoneTwoTabs from './fixtures/gen/phone-two-tabs.json';
import { box, ctx, tapAt } from './phoneStoryHelpers';
import { PHONE_SIDE_MIN, PHONE_STATUS_HEIGHT } from '../infra/dom/phoneLayout';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Phone Layout',
  component: FixtureApp,
  args: {
    fixture: asFixture(phoneTwoTabs),
    start: 'main-active',
    config: { phoneLayout: true },
  },
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

    expect(canvasElement.querySelectorAll('.tmux-status-bar')).toHaveLength(1);

    expect(canvasElement.querySelector('.phone-tab-strip')).toBeNull();
    expect(box(canvasElement.querySelector('.phone-pty')).top).toBeCloseTo(
      box(canvasElement.querySelector('.app-container')).top,
      0,
    );

    // 80 columns span the screen less 4px of padding each side (the grid's
    // outer borders).
    await waitFor(
      () => {
        expect(ctx().targetCols).toBe(80);
        expect(ctx().targetRows).toBe(24);
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

    // Top to bottom: the grid, the status line, the keys, the bar, then the
    // bottom view's card (the tab bar along its top, the tree under it).
    const grid = box(canvasElement.querySelector('.phone-pty .pane-container'));
    const status = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
    const keys = box(canvasElement.querySelector('.key-row'));
    const bar = box(canvasElement.querySelector('[data-testid="phone-divider"]'));
    const lower = box(canvasElement.querySelector('.phone-lower'));
    const tabBar = box(canvasElement.querySelector('.phone-tabs'));
    const tree = box(canvasElement.querySelector('.phone-tree'));
    expect(status.top).toBeGreaterThanOrEqual(grid.bottom - 1);
    expect(keys.top).toBeGreaterThanOrEqual(status.bottom - 1);
    expect(bar.top).toBeCloseTo(keys.bottom, 0);
    expect(lower.top).toBeCloseTo(bar.bottom, 0);
    expect(tabBar.top).toBeCloseTo(lower.top, 0);
    expect(tree.top).toBeGreaterThanOrEqual(tabBar.bottom - 1);
    expect(tree.height).toBeGreaterThan(100);
    expect(lower.bottom).toBeCloseTo(box(canvasElement.querySelector('.app-container')).bottom, 0);
    const radius = (sel: string, corner: string) =>
      parseFloat(getComputedStyle(canvasElement.querySelector(sel)!).getPropertyValue(corner));
    expect(radius('.phone-top', 'border-bottom-left-radius')).toBeGreaterThan(0);
    expect(radius('.phone-top', 'border-top-left-radius')).toBe(0);
    expect(radius('.phone-lower', 'border-top-right-radius')).toBeGreaterThan(0);
    expect(radius('.phone-lower', 'border-bottom-right-radius')).toBe(0);
    // The tree is the chrome's size, not the terminal's shrunken one.
    const row = canvasElement.querySelector('.phone-tree [role="treeitem"]');
    expect(row).not.toBeNull();
    expect(parseFloat(getComputedStyle(row!).fontSize)).toBeGreaterThanOrEqual(11);

    // The hints are written for 80 columns, so the whole line fits the screen.
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

    // Two even rows of six, each key a thumb's size.
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
    expect(keyAt('mic').top).toBeCloseTo(keyAt('←').top, 0);
    expect(keyAt('mic').left).toBeGreaterThan(keyAt('⏎').left);
    // The mic key is a drawn microphone, not a glyph.
    expect(canvasElement.querySelector('[data-key-row="mic"] svg rect')).not.toBeNull();

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

    await userEvent.click(ctrl);
    await userEvent.click(canvasElement.querySelector('[data-key-row="⏎"]') as HTMLElement);
    expect(ctrl.getAttribute('aria-pressed')).toBe('false');
  },
};

export const LandscapeAndTheKeyboard: Story = {
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
          'Held sideways, flat as a desktop: the tree on the left under the menu’s button, the terminal in the middle at the height that fits its 24 rows and tmux’s line over the keys, the side pane on the right, and the twelve keys in one row along the bottom. The menu’s button puts the app menu in the tree’s place and back. A keyboard coming up leaves the type as it was: the terminal is cut short and scrolled to keep the cursor’s row in view, the keys stay above the keyboard.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        expect(ctx().phoneLandscape).toBe(true);
        expect(canvasElement.querySelector('.phone-side-left .phone-tree')).not.toBeNull();
        expect(canvasElement.querySelector('.phone-pty .pane-layout-item')).not.toBeNull();
      },
      { timeout: 8000 },
    );
    const screen = box(canvasElement.querySelector('.app-container'));
    const left = box(canvasElement.querySelector('.phone-side-left'));
    const right = box(canvasElement.querySelector('.phone-side-right'));
    const pty = box(canvasElement.querySelector('.phone-pty'));
    const keys = box(canvasElement.querySelector('.key-row'));

    // The tree, the terminal and the side pane side by side, the keys along
    // the bottom the whole width; no bar and no bottom view.
    expect(left.left).toBeCloseTo(screen.left, 0);
    expect(left.right).toBeLessThanOrEqual(pty.left + 1);
    expect(right.left).toBeGreaterThanOrEqual(pty.right - 1);
    expect(right.right).toBeCloseTo(screen.right, 0);
    expect(pty.width).toBeCloseTo(80 * ctx().charWidth + 8, 0);
    expect(Math.min(left.width, right.width)).toBeGreaterThanOrEqual(PHONE_SIDE_MIN - 1);
    expect(keys.left).toBeCloseTo(screen.left, 0);
    expect(keys.width).toBeCloseTo(screen.width, 0);
    expect(keys.bottom).toBeCloseTo(screen.bottom, 0);
    expect(keys.top).toBeGreaterThanOrEqual(pty.bottom - 1);
    const tops = [...canvasElement.querySelectorAll('.key-row-key')].map((k) =>
      Math.round(box(k).top),
    );
    expect(tops).toHaveLength(12);
    expect(new Set(tops).size).toBe(1);
    expect(canvasElement.querySelector('[data-testid="phone-divider"]')).toBeNull();
    expect(canvasElement.querySelector('[data-testid="phone-bottom"]')).toBeNull();
    // The side pane is the desktop's column: no header, the window's background.
    const dock = canvasElement.querySelector('.phone-side-right [data-testid="phone-dock"]');
    expect(dock).not.toBeNull();
    expect(getComputedStyle(dock!).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    // All 24 rows and tmux's line on screen: the line ends above the keys.
    const line = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
    expect(line.bottom).toBeLessThanOrEqual(keys.top + 0.5);
    expect(line.bottom).toBeGreaterThan(keys.top - 25);

    // The menu's button: the app menu in the tree's place, and the tree back.
    const menuButton = canvasElement.querySelector('.phone-menu-toggle') as HTMLElement;
    expect(box(menuButton).top).toBeLessThan(box(canvasElement.querySelector('.phone-tree')).top);
    await userEvent.click(menuButton);
    await waitFor(() => {
      expect(canvasElement.querySelector('.phone-side-left .phone-menu')).not.toBeNull();
      expect(canvasElement.querySelector('.phone-side-left .phone-tree')).toBeNull();
    });
    await userEvent.click(menuButton);
    await waitFor(() =>
      expect(canvasElement.querySelector('.phone-side-left .phone-tree')).not.toBeNull(),
    );

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
          'A double tap on the terminal draws it at twice its size in a viewport that scrolls, around the point tapped — the browser’s zoom, not tmux’s: the window stays 80 × 24 and the cell measurement is untouched. A second double tap puts it back.',
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
    });
    expect(ctx().targetCols).toBe(80);
    expect(box(viewport).width).toBeCloseTo(grid.width, 0);

    tapAt(log, at.x, at.y);
    tapAt(log, at.x + 2, at.y + 2);
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
