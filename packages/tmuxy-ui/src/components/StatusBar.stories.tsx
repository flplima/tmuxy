import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { StatusBar } from './StatusBar';
import { FixtureProvider } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';

const PANES = asFixture(panes);

const meta: Meta<typeof StatusBar> = {
  title: 'Components/StatusBar',
  component: StatusBar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof StatusBar>;

export const WithCustomTabline: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={PANES} start="one">
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
    </FixtureProvider>
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
    const tab = await waitFor(() => canvas.getAllByRole('tab')[0], { timeout: 5000 });
    // The embedder's chrome is drawn, on the bar's row, ahead of the tabs.
    const lights = canvas.getByTestId('traffic-lights').getBoundingClientRect();
    const first = tab.getBoundingClientRect();
    expect(lights.width).toBeGreaterThan(0);
    expect(lights.height).toBeGreaterThan(0);
    expect(lights.right).toBeLessThanOrEqual(first.left);
    expect(Math.abs(lights.top + lights.height / 2 - (first.top + first.height / 2))).toBeLessThan(
      first.height / 2,
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
