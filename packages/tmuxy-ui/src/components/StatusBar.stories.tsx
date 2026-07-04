import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { StatusBar } from './StatusBar';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof StatusBar> = {
  title: 'Components/StatusBar',
  component: StatusBar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof StatusBar>;

export const SingleTab: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <StatusBar />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        expect(canvas.getAllByRole('tab').length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5000 },
    );
    expect(canvas.getByRole('button', { name: /create new tab/i })).toBeInTheDocument();
  },
};

export const WithCustomTabline: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <StatusBar
        renderTabline={({ children }) => (
          <>
            <div style={{ display: 'flex', gap: 6, paddingRight: 8 }} data-testid="traffic-lights">
              <span style={dot('#ff5f57')} />
              <span style={dot('#febc2e')} />
              <span style={dot('#28c840')} />
            </div>
            {children}
          </>
        )}
      />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'StatusBar accepts a renderTabline prop so embedders (the demo site, Tauri) can inject traffic-light style chrome alongside the tab list.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('traffic-lights')).toBeInTheDocument();
    await waitFor(
      () => {
        expect(canvas.getAllByRole('tab').length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 5000 },
    );
  },
};

function dot(color: string): React.CSSProperties {
  return {
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
  };
}
