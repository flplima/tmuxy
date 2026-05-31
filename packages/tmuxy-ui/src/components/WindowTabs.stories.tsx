import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { WindowTabs } from './WindowTabs';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof WindowTabs> = {
  title: 'Components/WindowTabs',
  component: WindowTabs,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof WindowTabs>;

export const Single: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <WindowTabs />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await waitFor(
      () => {
        const list = canvas.getAllByRole('tab');
        expect(list.length).toBeGreaterThanOrEqual(1);
        return list;
      },
      { timeout: 5000 },
    );
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  },
};

export const Multiple: Story = {
  render: () => (
    <ProviderHarness
      height={60}
      initCommands={[
        'rename-window welcome',
        'new-window',
        'rename-window features',
        'new-window',
        'rename-window dashboard',
        'select-window -t @1',
      ]}
    >
      <WindowTabs />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Three tabs with the middle one active. Click a tab to switch.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await waitFor(
      () => {
        const list = canvas.getAllByRole('tab');
        expect(list.length).toBeGreaterThanOrEqual(3);
        return list;
      },
      { timeout: 5000 },
    );

    // The "features" tab should start active.
    const featuresTab = tabs.find((t) => /features/i.test(t.textContent ?? ''));
    expect(featuresTab).toBeDefined();
    expect(featuresTab).toHaveAttribute('aria-selected', 'true');

    // Clicking the "dashboard" tab flips active state via optimistic update.
    const dashboardTab = tabs.find((t) => /dashboard/i.test(t.textContent ?? ''));
    expect(dashboardTab).toBeDefined();
    await userEvent.click(dashboardTab!);
    await waitFor(
      () => {
        const refreshed = canvas.getAllByRole('tab');
        const refreshedDashboard = refreshed.find((t) => /dashboard/i.test(t.textContent ?? ''));
        expect(refreshedDashboard).toHaveAttribute('aria-selected', 'true');
      },
      { timeout: 3000 },
    );
  },
};

export const ManyTabs: Story = {
  render: () => (
    <ProviderHarness
      height={60}
      initCommands={[
        'rename-window α',
        'new-window',
        'rename-window β',
        'new-window',
        'rename-window γ',
        'new-window',
        'rename-window δ',
        'new-window',
        'rename-window ε',
        'new-window',
        'rename-window ζ',
        'new-window',
        'rename-window η',
        'select-window -t @0',
      ]}
    >
      <WindowTabs />
    </ProviderHarness>
  ),
  parameters: {
    docs: { description: { story: 'Many tabs — list scrolls horizontally without a scrollbar.' } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBeGreaterThanOrEqual(7);
      },
      { timeout: 5000 },
    );
  },
};
