/**
 * Snackbar stories — the error corner: one entry, a stack, and the close
 * button. Errors are raised through the machine exactly as the app does.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { Snackbar } from './Snackbar';
import { useAppSend } from '../machines/AppContext';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof Snackbar> = {
  title: 'Components/Snackbar',
  component: Snackbar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof Snackbar>;

/** Buttons that raise the errors the app itself would raise. */
function Triggers({ errors }: { errors: string[] }) {
  const send = useAppSend();
  return (
    <div style={{ display: 'flex', gap: 8, padding: 12 }}>
      {errors.map((text) => (
        <button key={text} type="button" onClick={() => send({ type: 'NOTIFY', text })}>
          {text}
        </button>
      ))}
    </div>
  );
}

const ERRORS = ["can't find window: @999", 'pane too small', 'Copy failed: not allowed'];

export const Stacked: Story = {
  render: () => (
    <ProviderHarness height={320}>
      <Triggers errors={ERRORS} />
      <Snackbar />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const text of ERRORS) await userEvent.click(canvas.getByRole('button', { name: text }));
    // The stack is fixed to the viewport, so look it up from the document.
    const body = within(document.body);
    await waitFor(() => expect(body.getAllByRole('alert')).toHaveLength(ERRORS.length));
    const alerts = body.getAllByRole('alert');
    // Oldest at the top, and every entry is actually on screen.
    expect(alerts[0]).toHaveTextContent(ERRORS[0]);
    for (const alert of alerts) {
      const rect = alert.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    }
    // The same error again does not add a fourth.
    await userEvent.click(canvas.getByRole('button', { name: ERRORS[1] }));
    expect(body.getAllByRole('alert')).toHaveLength(ERRORS.length);
    // Close the middle one; the others stay.
    await userEvent.click(within(alerts[1]).getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(body.getAllByRole('alert')).toHaveLength(ERRORS.length - 1));
    // (The trigger button still says it; the alert is what went away.)
    expect(body.getAllByRole('alert').map((a) => a.textContent)).not.toContain(
      expect.stringContaining(ERRORS[1]),
    );
  },
};
