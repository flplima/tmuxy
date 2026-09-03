/**
 * PaneLayout stories (demo engine).
 *
 * The active tiled pane carries a 1px outline in the theme's focus colour —
 * the classic tmux green on the default and gruvbox themes. Green means "the
 * keyboard is in this pane": the cue leaves while the tree, the dock or a
 * float holds the keyboard, even though tmux's active pane is unchanged.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Pane Layout',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

interface AppActor {
  send(event: { type: string; name?: string }): void;
  getSnapshot(): { context: { activePaneId: string | null } };
}
const app = () => (window as unknown as { app: AppActor }).app;

const activeOutline = () => {
  const el = document.querySelector<HTMLElement>('.pane-layout-item.pane-active');
  return el ? getComputedStyle(el).outlineColor : null;
};

export const ActivePaneOutlineDefaultAndGruvbox: Story = {
  args: { height: 500, initCommands: ['split-window -h'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %1/i }, { timeout: 8000 });

    // Default theme: the active pane's outline is the terminal green, the
    // inactive pane's is the dim frame colour.
    app().send({ type: 'SET_THEME', name: 'default' });
    await waitFor(() => expect(activeOutline()).toBe('rgb(0, 205, 0)'), { timeout: 8000 });
    const inactive = document.querySelector<HTMLElement>('.pane-layout-item.pane-inactive')!;
    expect(getComputedStyle(inactive).outlineColor).not.toBe('rgb(0, 205, 0)');

    // Clicking the other pane moves the green with the keyboard.
    const before = app().getSnapshot().context.activePaneId;
    await userEvent.click(inactive.querySelector('[role="group"]')!);
    await waitFor(() => expect(app().getSnapshot().context.activePaneId).not.toBe(before), {
      timeout: 5000,
    });
    await waitFor(() => {
      const active = document.querySelector<HTMLElement>('.pane-layout-item.pane-active')!;
      expect(active.dataset.paneId ?? active.getAttribute('data-pane-id')).not.toBeNull();
      expect(getComputedStyle(active).outlineColor).toBe('rgb(0, 205, 0)');
    });

    // Gruvbox: its own bright green.
    app().send({ type: 'SET_THEME', name: 'gruvbox' });
    await waitFor(() => expect(activeOutline()).toBe('rgb(184, 187, 38)'), { timeout: 8000 });

    // While the tree holds the keyboard (prefix t) no pane is green.
    const user = userEvent.setup({ delay: 5 });
    await user.keyboard('{Control>}a{/Control}t');
    await waitFor(() => expect(document.querySelector('.sidebar-tree')).not.toBeNull(), {
      timeout: 8000,
    });
    await userEvent.click(document.querySelector('[data-testid="sidebar-content"]') as HTMLElement);
    await waitFor(
      () => expect(document.querySelector('.pane-layout-item.pane-active')).toBeNull(),
      {
        timeout: 5000,
      },
    );
    // `l` hands the keyboard back: the green returns.
    await user.keyboard('l');
    await waitFor(() => expect(activeOutline()).toBe('rgb(184, 187, 38)'), { timeout: 5000 });
  },
};
