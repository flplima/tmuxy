import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  paneGroupsState,
  recordClassHistory,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Pane Groups',
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
 * The right pane holds a group of two; click the left pane, then the tab of
 * the member the group shows. The focus goes there and stays: a line typed
 * after the first one's output — the output is what brings tmux's next
 * state — still lands in the group, never in the left pane.
 */
export const ClickingTheShownMembersTabTakesTheFocus: Story = {
  args: {
    // `group add` groups the active pane: the right one, `%1`.
    initCommands: [
      'send-keys -t %0 -l "tmuxy pane group add && tmux set -g @tmuxy-story-ready 1"',
      'send-keys -t %0 Enter',
    ],
    initDoneOption: '@tmuxy-story-ready',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    const paneEl = (id: string) =>
      paneGroups(canvas).find((p: HTMLElement) => p.getAttribute('data-pane-id') === id);

    let shown = '';
    await waitFor(
      () => {
        const group = paneGroupsState().find((g) => g.paneIds.length === 2);
        expect(group).toBeDefined();
        shown = group!.paneIds.find((id) => paneEl(id))!;
        expect(shown).toBeDefined();
        expect(paneEl('%0')).toBeDefined();
      },
      { timeout: 30000, interval: 250 },
    );

    await user.click(paneEl('%0')!);
    await waitFor(() => expect(activePaneId()).toBe('%0'), { timeout: 15000, interval: 200 });

    const wrapper = paneEl(shown)!.closest('.pane-layout-item') as HTMLElement;
    const tab = wrapper.querySelector<HTMLElement>(`.pane-tab[data-pane-tab="${shown}"]`)!;
    expect(tab.getBoundingClientRect().width).toBeGreaterThan(0);
    await user.click(tab);
    await waitFor(() => expect(wrapper).toHaveClass('pane-active'), { timeout: 5000 });
    const classes = recordClassHistory(wrapper);

    pasteLine('echo first$((40+2))');
    await waitFor(() => expect(paneEl(shown)!.textContent).toContain('first42'), {
      timeout: 15000,
      interval: 200,
    });
    pasteLine('echo second$((40+2))');
    await waitFor(() => expect(paneEl(shown)!.textContent).toContain('second42'), {
      timeout: 15000,
      interval: 200,
    });

    classes.disconnect();
    expect(classes.history().filter((c) => !c.includes('pane-active'))).toEqual([]);
    expect(paneEl('%0')!.textContent).not.toContain('42');
    expect(activePaneId()).toBe(shown);
  },
};
