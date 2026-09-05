/**
 * Tab Overview stories (demo engine).
 *
 * ctrl+0 zooms the current tab out into a grid of every tab; a slot click
 * zooms that tab back in, the trailing "+" creates a tab and a slot's ✕
 * closes one. Everything runs through the app machine and the demo tmux, so
 * these stories exercise the same chain the web and desktop apps use.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Tab Overview',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface AppSnap {
  context: {
    activeWindowId: string | null;
    tabOverviewOpen: boolean;
    windows: Array<{ id: string; index: number; name: string; windowType: string | null }>;
  };
}
const app = () => (window as unknown as { app: { getSnapshot(): AppSnap } }).app.getSnapshot();
const tabs = () =>
  app()
    .context.windows.filter((w) => w.windowType === 'tab')
    .sort((a, b) => a.index - b.index);

async function waitForOverview(open: boolean): Promise<HTMLElement | null> {
  return waitFor(
    () => {
      const el = document.querySelector<HTMLElement>('[data-testid="tab-overview"]');
      if (Boolean(el) !== open) throw new Error(`overview ${open ? 'not open' : 'still open'}`);
      return el;
    },
    { timeout: 8000 },
  );
}

export const OpenClickSlotSwitchesTab: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'new-window', 'rename-window logs', 'new-window'],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });

    await user.keyboard('{Control>}0{/Control}');
    const overview = (await waitForOverview(true)) as HTMLElement;

    // One slot per tab, in strip order, plus the "+" slot; the current tab's
    // slot carries the live grid.
    const slots = [
      ...overview.querySelectorAll<HTMLElement>('[data-testid^="tab-overview-slot-"]'),
    ];
    expect(slots.map((s) => s.dataset.testid)).toEqual(
      tabs().map((w) => `tab-overview-slot-${w.id}`),
    );
    expect(overview.querySelector('[data-testid="tab-overview-new"]')).not.toBeNull();
    expect(overview.textContent).toContain('1:main');
    expect(overview.textContent).toContain('2:logs');
    const active = overview.querySelector('.tab-overview-slot.is-active') as HTMLElement;
    expect(active.dataset.testid).toBe(`tab-overview-slot-${app().context.activeWindowId}`);

    // A tab that is NOT current shows its panes' screens, not a wireframe:
    // the "main" slot's box holds a rendered terminal with that pane's text.
    // (The still appears a render after the frame is measured.)
    await waitFor(
      () => {
        const shot = slots[0].querySelector('.tab-overview-shot .terminal-line');
        expect(shot).not.toBeNull();
        expect(slots[0].querySelector('.tab-overview-shot')!.textContent).toMatch(/\S/);
      },
      { timeout: 8000 },
    );
    const frame = active.querySelector('.tab-overview-frame') as HTMLElement;
    const layout = document.querySelector('.pane-layout') as HTMLElement;
    // The zoom-out is a transition: wait for the grid to settle in the frame.
    await waitFor(() => {
      const f = frame.getBoundingClientRect();
      const l = layout.getBoundingClientRect();
      expect(l.left).toBeGreaterThanOrEqual(f.left - 1);
      expect(l.right).toBeLessThanOrEqual(f.right + 1);
    });

    // Click "logs": it becomes current and the overview closes.
    const logs = tabs()[1];
    await user.click(slots[1]);
    await waitForOverview(false);
    await waitFor(() => expect(app().context.activeWindowId).toBe(logs.id));
    await waitFor(() => expect(getComputedStyle(layout).transform).toBe('none'));

    // The header's grid button is the same toggle: open, pressed, close.
    const toggle = canvas.getByTestId('tab-overview-toggle');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    await waitForOverview(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await user.click(toggle);
    await waitForOverview(false);
  },
};

export const PlusCreatesAndCloseKills: Story = {
  args: { height: 500, initCommands: ['rename-window main', 'new-window', 'rename-window logs'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane/i }, { timeout: 8000 });
    const user = userEvent.setup({ delay: 5 });

    await user.keyboard('{Control>}0{/Control}');
    let overview = (await waitForOverview(true)) as HTMLElement;
    await user.click(overview.querySelector('[data-testid="tab-overview-new"]') as HTMLElement);
    await waitForOverview(false);
    await waitFor(() => expect(tabs()).toHaveLength(3));

    await user.keyboard('{Control>}0{/Control}');
    overview = (await waitForOverview(true)) as HTMLElement;
    const doomed = tabs()[2].id;
    await user.click(
      overview.querySelector(
        `[data-testid="tab-overview-slot-${doomed}"] .tab-overview-slot-close`,
      ) as HTMLElement,
    );
    await waitFor(() => expect(tabs().map((w) => w.id)).not.toContain(doomed));
    // Closing keeps the overview open; Escape leaves it.
    expect(document.querySelector('[data-testid="tab-overview"]')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitForOverview(false);
  },
};
