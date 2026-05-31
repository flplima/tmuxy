import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { TmuxStatusBar } from './TmuxStatusBar';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof TmuxStatusBar> = {
  title: 'Components/TmuxStatusBar',
  component: TmuxStatusBar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof TmuxStatusBar>;

export const Default: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <TmuxStatusBar />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    // Session hostname segment renders even when no live commands have run.
    const host = bar.querySelector('.statusline-host');
    expect(host).not.toBeNull();
    expect(host).toHaveClass('statusline-clickable');
  },
};

export const Demo: Story = {
  render: () => (
    <ProviderHarness height={60} config={{ isDemo: true }}>
      <TmuxStatusBar />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'With `isDemo`, the hostname / session segments lose their click handlers (no SSH or session switcher in the demo site).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    const host = bar.querySelector('.statusline-host');
    expect(host).not.toBeNull();
    // In demo mode the click handler is dropped, so the clickable class is gone.
    expect(host).not.toHaveClass('statusline-clickable');
    expect(host).toHaveTextContent(/demo@localhost/);
  },
};
