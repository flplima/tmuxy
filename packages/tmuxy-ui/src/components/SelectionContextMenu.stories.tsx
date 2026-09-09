/**
 * SelectionContextMenu stories — the two things to do with selected text,
 * each with its icon, and nothing else.
 */

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { SelectionContextMenu } from './SelectionContextMenu';
import { ProviderHarness } from '../stories/StoryHarness';

/** Hosts the menu the way TerminalPane does on right-click over a selection. */
function SelectionMenuHost() {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height: 240 }}>
      <div data-testid="ctx-state">{open ? 'open' : 'closed'}</div>
      {open && (
        <SelectionContextMenu
          paneId="%0"
          x={120}
          y={60}
          selectedText="cargo test -p tmuxy-core"
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

const meta: Meta<typeof SelectionContextMenu> = {
  title: 'Components/SelectionContextMenu',
  component: SelectionContextMenu,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof SelectionContextMenu>;

export const CopyOrSendKeys: Story = {
  render: () => (
    <ProviderHarness height={300}>
      <SelectionMenuHost />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const items = await waitFor(() => {
      const found = canvas.getAllByRole('menuitem');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(items.map((el) => el.textContent?.trim())).toEqual(['Copy', 'Send keys']);
    // Each item carries an inline icon that takes the item's colour.
    for (const item of items) {
      const icon = item.querySelector('svg.menu-item-icon');
      expect(icon).not.toBeNull();
      expect(icon!.getBoundingClientRect().width).toBeGreaterThan(0);
    }
    expect(canvas.queryByRole('menuitem', { name: /google|chatgpt/i })).toBeNull();

    // Sending the keys is the end of the selection's job: the menu closes.
    await userEvent.click(canvas.getByRole('menuitem', { name: /send keys/i }));
    await waitFor(() => {
      expect(canvas.getByTestId('ctx-state')).toHaveTextContent('closed');
    });
  },
};
