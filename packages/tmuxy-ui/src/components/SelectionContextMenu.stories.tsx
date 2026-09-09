/**
 * SelectionContextMenu stories — the two things to do with selected text,
 * each with its icon, and nothing else.
 */

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { SelectionContextMenu } from './SelectionContextMenu';
import { ProviderHarness } from '../stories/StoryHarness';

const SELECTED = 'cargo test -p tmuxy-core';

/**
 * Hosts the menu the way TerminalPane does on right-click over a selection:
 * the text is selected first (by the play function, in the browser's own
 * selection), then the menu opens about it.
 */
function SelectionMenuHost() {
  const [range, setRange] = useState<Range | null>(null);
  const open = range !== null;
  return (
    <div style={{ height: 240, fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
      <div data-testid="ctx-state">{open ? 'open' : 'closed'}</div>
      <p data-testid="selectable" style={{ userSelect: 'text' }}>
        {SELECTED}
      </p>
      <button
        type="button"
        onClick={() => setRange(window.getSelection()!.getRangeAt(0).cloneRange())}
      >
        Open menu
      </button>
      {open && (
        <SelectionContextMenu
          paneId="%0"
          x={120}
          y={60}
          selectedText={SELECTED}
          selectionRange={range}
          onClose={() => setRange(null)}
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
    // Select the text the way the user did, then open the menu about it.
    const selectAll = (el: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    };
    selectAll(canvas.getByTestId('selectable'));
    expect(window.getSelection()!.toString()).toBe(SELECTED);
    await userEvent.click(canvas.getByRole('button', { name: /open menu/i }));

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

    // The selection is pinned while the menu is up: the menu takes focus on
    // open and each item on hover, which collapses the selection on WebKit.
    // Whatever collapses it, it comes back.
    await userEvent.hover(items[0]);
    await userEvent.hover(items[1]);
    window.getSelection()!.removeAllRanges();
    await waitFor(() => {
      expect(window.getSelection()!.toString()).toBe(SELECTED);
    });

    // Sending the keys is the end of the selection's job: the menu closes.
    await userEvent.click(canvas.getByRole('menuitem', { name: /send keys/i }));
    await waitFor(() => {
      expect(canvas.getByTestId('ctx-state')).toHaveTextContent('closed');
    });
  },
};
