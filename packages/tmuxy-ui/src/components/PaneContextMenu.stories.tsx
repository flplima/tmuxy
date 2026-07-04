import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { PaneContextMenu } from './PaneContextMenu';
import { ProviderHarness } from '../stories/StoryHarness';

/**
 * Hosts the controlled menu the way TerminalPane does on right-click: open at
 * an anchor point, closed via the menu's own onClose. The marker div lets the
 * play function observe the close callback without reaching into state.
 */
function ContextMenuHost({ paneId = '%0' }: { paneId?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height: 360 }}>
      <div data-testid="ctx-state">{open ? 'open' : 'closed'}</div>
      {open && <PaneContextMenu paneId={paneId} x={120} y={80} onClose={() => setOpen(false)} />}
    </div>
  );
}

const meta: Meta<typeof PaneContextMenu> = {
  title: 'Components/PaneContextMenu',
  component: PaneContextMenu,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof PaneContextMenu>;

export const SinglePane: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <ContextMenuHost />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const closeItem = await waitFor(() => canvas.getByRole('menuitem', { name: /close pane/i }));

    // Keybinding labels are derived from the adapter's bindings (prefix x).
    expect(closeItem.querySelector('.menu-keybinding')?.textContent).toBe('ctrl+a x');
    expect(canvas.getByRole('menuitem', { name: /split pane below/i })).toBeInTheDocument();

    // Pane navigation needs a second pane.
    expect(canvas.getByRole('menuitem', { name: /next pane/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

export const MultiPane: Story = {
  render: () => (
    <ProviderHarness height={400} initCommands={['split-window -h']}>
      <ContextMenuHost />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Once the split lands, navigation items become enabled.
    await waitFor(() => {
      const nextPane = canvas.getByRole('menuitem', { name: /next pane/i });
      expect(nextPane).not.toHaveAttribute('aria-disabled');
    });

    // Selecting an item fires the host's onClose (menu dismissed).
    await userEvent.click(canvas.getByRole('menuitem', { name: /copy mode/i }));
    await waitFor(() => {
      expect(canvas.getByTestId('ctx-state')).toHaveTextContent('closed');
    });
  },
};
