/**
 * The phone layout (demo engine), at a 390 × 844 phone's width.
 *
 * The whole 80 × 25 terminal on top — 80 columns spanning the screen, tmux's
 * status line as the 25th row — then the key row, then the tab/pane tree. No
 * tab strip and no bottom bar of the app's own. The frame is not the viewport
 * the media query reads, so the story asks for the layout through the config.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Phone Layout',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface Snap {
  context: { targetCols: number; targetRows: number; charWidth: number; phoneLayout: boolean };
}
const ctx = () => (window as unknown as { app: { getSnapshot(): Snap } }).app.getSnapshot().context;

const box = (el: Element | null) => {
  if (!el) throw new Error('missing element');
  return el.getBoundingClientRect();
};

export const PhoneKeyboardDown: Story = {
  args: {
    width: 390,
    height: 844,
    config: { phoneLayout: true },
    initCommands: ['rename-window main', 'new-window -n logs', 'select-window -t 0'],
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 844 },
      description: {
        story:
          'The terminal is asked for at 80 × 24 and drawn at the cell that fits 80 columns across; tmux’s line sits under it as row 25. ctrl latches on one tap, locks on a second and lets go on a third; the tree lists both tabs below the keys.',
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

    // No tab strip, no bottom bar of the app's own.
    expect(canvasElement.querySelector('.tab-list')).toBeNull();
    expect(canvasElement.querySelectorAll('.tmux-status-bar')).toHaveLength(1);

    // 80 columns asked for, and 80 columns span the screen.
    await waitFor(
      () => {
        expect(ctx().targetCols).toBe(80);
        expect(ctx().targetRows).toBe(24);
        const container = box(canvasElement.querySelector('.pane-container'));
        const span = 80 * ctx().charWidth;
        expect(span).toBeLessThanOrEqual(container.width - 24);
        expect(span).toBeGreaterThan(container.width - 24 - 80 / window.devicePixelRatio);
      },
      { timeout: 8000 },
    );

    // Top to bottom: the grid, the status line as its last row, the keys, the tree.
    const grid = box(canvasElement.querySelector('.phone-pty .pane-container'));
    const status = box(canvasElement.querySelector('.phone-pty .tmux-status-bar'));
    const keys = box(canvasElement.querySelector('.key-row'));
    const tree = box(canvasElement.querySelector('.phone-tree'));
    expect(status.top).toBeGreaterThanOrEqual(grid.bottom - 1);
    expect(keys.top).toBeGreaterThanOrEqual(status.bottom - 1);
    expect(tree.top).toBeGreaterThanOrEqual(keys.bottom - 1);
    expect(tree.height).toBeGreaterThan(100);
    // The tree is the chrome's size, not the terminal's shrunken one.
    const row = canvasElement.querySelector('.phone-tree [role="treeitem"]');
    expect(row).not.toBeNull();
    expect(parseFloat(getComputedStyle(row!).fontSize)).toBeGreaterThanOrEqual(11);

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
