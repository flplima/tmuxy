import { expect, userEvent, waitFor, within } from 'storybook/test';

/**
 * Fix a sidebar column the way a user does, so it docks from then on: open it
 * with its header toggle, press `prefix s` (`prefix S` for the right one) on
 * the open column, and close it again. A column starts out overlaying the
 * panes; a story about a docked column calls this first.
 */
export async function fixColumn(canvasElement: HTMLElement, side: 'left' | 'right') {
  const canvas = within(canvasElement);
  const name = side === 'left' ? /toggle tree sidebar/i : /toggle terminal sidebar/i;
  const column = () => document.querySelector(`.sidebar-column-${side}`) as HTMLElement | null;
  const toggle = await canvas.findByRole('button', { name }, { timeout: 8000 });
  await userEvent.click(toggle);
  await waitFor(() => expect(column()).not.toBeNull(), { timeout: 8000 });
  await userEvent.keyboard('{Control>}a{/Control}');
  await userEvent.keyboard(side === 'left' ? 's' : 'S');
  await waitFor(() => expect(column()).not.toHaveClass('is-overlay'), { timeout: 5000 });
  await userEvent.click(toggle);
  await waitFor(() => expect(column()).toBeNull(), { timeout: 5000 });
}
