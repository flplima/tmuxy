import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { PaneHeader } from './PaneHeader';
import { ProviderHarness } from '../stories/StoryHarness';
import { useAppSelector, selectPanes } from '../machines/AppContext';

const meta: Meta<typeof PaneHeader> = {
  title: 'Components/PaneHeader',
  component: PaneHeader,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof PaneHeader>;

/** Picks the first pane in the active window and renders a header for it. */
function FirstPaneHeader({
  titleOverride,
  widgetName,
}: {
  titleOverride?: string;
  widgetName?: string;
}) {
  const panes = useAppSelector(selectPanes);
  const first = panes[0];
  if (!first) return <div style={{ color: 'white' }}>no panes</div>;
  return <PaneHeader paneId={first.tmuxId} titleOverride={titleOverride} widgetName={widgetName} />;
}

export const SinglePane: Story = {
  render: () => (
    <ProviderHarness height={50}>
      <FirstPaneHeader />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await waitFor(
      () => {
        const list = canvasElement.querySelectorAll('.pane-tab');
        expect(list.length).toBeGreaterThanOrEqual(1);
        return list;
      },
      { timeout: 5000 },
    );
    expect(tabs[0]).toHaveClass('pane-tab-active');
    // The pane menu trigger should be present.
    expect(canvas.getByRole('button', { name: /pane menu/i })).toBeInTheDocument();
  },
};

export const WithWidgetIcon: Story = {
  render: () => (
    <ProviderHarness height={50}>
      <FirstPaneHeader widgetName="markdown" titleOverride="README.md" />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story: 'When widgetName is provided, the icon switches to the widget glyph (markdown).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      expect(canvas.getByText('README.md')).toBeInTheDocument();
    });
  },
};

export const PaneGroup: Story = {
  render: () => (
    <ProviderHarness
      height={50}
      initCommands={[
        // Add the active pane to a group, creating a sibling
        'tmuxy-pane-group-add',
        'tmuxy-pane-group-add',
      ]}
    >
      <FirstPaneHeader />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Pane group: three sibling panes share the same visual slot; the header renders one tab per group member.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        const tabs = canvasElement.querySelectorAll('.pane-tab');
        expect(tabs.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 6000 },
    );
  },
};
