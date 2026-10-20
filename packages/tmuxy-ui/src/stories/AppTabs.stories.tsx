import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { focusFirstPane } from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Tabs',
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
 * New-tab regression (two bugs, real tmux):
 *  1. Creating a tab must not flash a transient EXTRA tab. A `break-pane` tags
 *     the new window `@tmuxy-window-type=tab` a beat before its pane settles;
 *     the optimistic store must hide that tab-typed-but-paneless newborn (it
 *     stands the placeholder in for it) so the tab bar never shows a 3rd tab
 *     that blinks away. A MutationObserver over the tab list catches the blink.
 *  2. The new tab's pane must show its FIRST terminal row. New windows are born
 *     without `pane-border-status top` unless it's set globally, which would
 *     leave the pane at y=0 where the 24px PaneHeader steals row 0. The row must
 *     render fully below the header.
 */
export const NewTabNoBlinkFirstRowVisible: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const tabList = canvasElement.querySelector('.tab-list') as HTMLElement;
    const tabCount = () => tabList.querySelectorAll('.tab-name').length;
    const before = tabCount();

    // Bug 1: watch the tab bar for any transient tab beyond the one we create.
    let maxTabs = before;
    const obs = new MutationObserver(() => {
      maxTabs = Math.max(maxTabs, tabCount());
    });
    obs.observe(tabList, { childList: true, subtree: true, attributes: true });
    let running = true;
    const tick = () => {
      if (!running) return;
      maxTabs = Math.max(maxTabs, tabCount());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const add = await canvas.findByRole('button', { name: /create new tab/i }, { timeout: 8000 });
    await user.click(add);
    await waitFor(() => expect(tabCount()).toBe(before + 1), { timeout: 30000, interval: 100 });
    await sleep(2500); // settle
    running = false;
    obs.disconnect();

    // Bug 1: the tab bar never held more than the one new tab (no blink).
    expect(
      maxTabs,
      `tab bar flashed ${maxTabs} tabs (expected at most ${before + 1})`,
    ).toBeLessThanOrEqual(before + 1);
    expect(tabCount()).toBe(before + 1);

    // Bug 2: the new tab's pane shows its first terminal row, fully below the
    // header (not clipped behind it).
    const wrapper = canvasElement.querySelector(
      '.pane-layout-item.pane-active .pane-wrapper',
    ) as HTMLElement;
    const header = wrapper.querySelector('.pane-header') as HTMLElement;
    const firstLine = wrapper.querySelector('.pane-content .terminal-line') as HTMLElement;
    expect(header).not.toBeNull();
    expect(firstLine).not.toBeNull();
    const hb = header.getBoundingClientRect();
    const fb = firstLine.getBoundingClientRect();
    expect(
      fb.top,
      `first terminal row (top=${Math.round(fb.top)}) is hidden behind the header (bottom=${Math.round(hb.bottom)})`,
    ).toBeGreaterThanOrEqual(hb.bottom - 1);
  },
};
