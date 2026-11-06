import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import { pasteLine, focusFirstPane } from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Sessions & Lifecycle',
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
 * Killing the tmux server in the guest ends the control stream (`%exit`): the
 * app shows its non-recoverable status screen, not a blank or frozen UI.
 * Reached by really killing the server.
 */
export const FatalScreen: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmux kill-server');
    await waitFor(
      () =>
        expect(
          canvasElement.ownerDocument.querySelector('[data-testid="fatal-display"]'),
        ).not.toBeNull(),
      { timeout: 40000, interval: 500 },
    );
  },
};
