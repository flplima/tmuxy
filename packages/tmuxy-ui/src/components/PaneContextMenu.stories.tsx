import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { PaneContextMenu } from './PaneContextMenu';
import { FixtureProvider } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';
import { PaneId } from '../domain/ids';

/**
 * Hosts the controlled menu the way TerminalPane does on right-click: open at
 * an anchor point, closed via the menu's own onClose. The marker div lets the
 * play function observe the close callback without reaching into state.
 */
function ContextMenuHost({ paneId = PaneId.make('%0') }: { paneId?: PaneId }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height: 360, color: 'var(--text-primary)' }}>
      <div data-testid="ctx-state">{open ? 'open' : 'closed'}</div>
      {open && <PaneContextMenu paneId={paneId} x={120} y={80} onClose={() => setOpen(false)} />}
    </div>
  );
}

const PANES = asFixture(panes);

const meta: Meta<typeof PaneContextMenu> = {
  title: 'Components/PaneContextMenu',
  component: PaneContextMenu,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof PaneContextMenu>;

export const SinglePane: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <ContextMenuHost />
    </FixtureProvider>
  ),
  play: async () => {
    // The menu is portalled out of the story's tree (components/floating), so
    // its items live on the document.
    const menu = within(document.body);
    const closeItem = await waitFor(() => menu.getByRole('menuitem', { name: /close pane/i }));

    // Keybinding labels are derived from the recorded config's bindings: its
    // `x` asks first (`confirm-before … kill-pane`) and is still Close Pane.
    expect(closeItem.querySelector('.menu-keybinding')?.textContent).toBe('ctrl+a x');
    // Both `"` and `-` split below in the pane's directory; tmux lists `"` first.
    expect(
      menu.getByRole('menuitem', { name: /split pane below/i }).querySelector('.menu-keybinding')
        ?.textContent,
    ).toBe('ctrl+a "');

    // A context menu is about the pane it was opened on: navigation between
    // panes and the adjacent swaps are the app menu's, not this one's.
    expect(menu.queryByRole('menuitem', { name: /next pane/i })).toBeNull();
    expect(menu.queryByRole('menuitem', { name: /swap with previous/i })).toBeNull();
    // The marked-pane items need a marked pane.
    expect(menu.getByRole('menuitem', { name: /swap with marked pane/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

export const MultiPane: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="side-by-side">
      <ContextMenuHost />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = within(document.body);

    // With a second pane beside it, the menu offers the pane's own items.
    await waitFor(() => {
      expect(menu.getByRole('menuitem', { name: /move to new tab/i })).not.toHaveAttribute(
        'aria-disabled',
      );
    });

    // Selecting an item fires the host's onClose (menu dismissed).
    await userEvent.click(menu.getByRole('menuitem', { name: /copy mode/i }));
    await waitFor(() => {
      expect(canvas.getByTestId('ctx-state')).toHaveTextContent('closed');
    });
  },
};
