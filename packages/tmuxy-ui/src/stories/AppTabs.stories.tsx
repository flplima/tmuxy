import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { tmuxCaughtUp } from './tmuxBarrier';
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
 * Two new-tab regressions on real tmux. (1) No transient extra tab: a
 * `break-pane` tags the new window `@tmuxy-window-type=tab` a beat before its
 * pane settles, and the optimistic store must hide that paneless newborn.
 * (2) The new pane shows its first row: new windows are born without
 * `pane-border-status top` unless it is set globally, which leaves the pane at
 * y=0 where the 24px PaneHeader would cover row 0.
 */
export const NewTabNoBlinkFirstRowVisible: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);

    const tabList = canvasElement.querySelector('.tab-list') as HTMLElement;
    const tabCount = () => tabList.querySelectorAll('.tab-name').length;
    const before = tabCount();

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
    await tmuxCaughtUp();
    running = false;
    obs.disconnect();

    expect(
      maxTabs,
      `tab bar flashed ${maxTabs} tabs (expected at most ${before + 1})`,
    ).toBeLessThanOrEqual(before + 1);
    expect(tabCount()).toBe(before + 1);

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
