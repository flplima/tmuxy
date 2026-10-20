import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { WindowTabs } from './WindowTabs';
import { FixtureProvider } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';

const PANES = asFixture(panes);

const meta: Meta<typeof WindowTabs> = {
  title: 'Components/WindowTabs',
  component: WindowTabs,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof WindowTabs>;

export const Single: Story = {
  render: () => (
    <FixtureProvider height={60} fixture={PANES} start="one">
      <WindowTabs />
    </FixtureProvider>
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

    // A lone tab reads as a label on the window, so it sits where every other
    // tab sits — hard against the left of the strip — rather than drifting to
    // the far edge away from the sidebar toggle it follows.
    const strip = canvasElement.querySelector('.tab-list') as HTMLElement;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tabs[0].getBoundingClientRect();
    expect(tabBox.left - stripBox.left).toBeLessThan(stripBox.width / 4);

    // ...and it takes no hover background: there is nothing to switch to, and
    // on the desktop this tab is the window's drag handle.
    await userEvent.hover(tabs[0]);
    await waitFor(() => {
      expect(getComputedStyle(tabs[0]).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    });
  },
};
