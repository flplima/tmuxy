/**
 * Snackbar stories — the error corner: one entry, a stack, and the close
 * button; a tmux message beside an error; and the reconnect notice a dropped
 * channel raises once it has stayed down. Entries are raised through the
 * machine exactly as the app does.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { Snackbar } from './Snackbar';
import { useAppSend } from '../machines/appHooks';
import { FixtureProvider } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import panes from '../stories/fixtures/gen/panes.json';
import { RECONNECT_NOTICE_DELAY_MS } from '../machines/constants';

const PANES = asFixture(panes);

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
    <FixtureProvider height={320} fixture={PANES} start="one">
      <Triggers errors={ERRORS} />
      <Snackbar />
    </FixtureProvider>
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

/** A tmux `display-message`, as the tmux actor raises it on `%message`. */
function MessageTrigger({ text }: { text: string }) {
  const send = useAppSend();
  return (
    <button type="button" onClick={() => send({ type: 'NOTIFY', text, kind: 'info' })}>
      {text}
    </button>
  );
}

const MESSAGE = 'build done';

/**
 * A tmux message is a status, not an alert: announced politely, and drawn
 * without the red edge that means error — while an error beside it keeps it.
 */
export const TmuxMessage: Story = {
  render: () => (
    <FixtureProvider height={320} fixture={PANES} start="one">
      <div style={{ display: 'flex', gap: 8, padding: 12 }}>
        <MessageTrigger text={MESSAGE} />
        <Triggers errors={[ERRORS[0]]} />
      </div>
      <Snackbar />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: MESSAGE }));
    await userEvent.click(canvas.getByRole('button', { name: ERRORS[0] }));
    // The stack is fixed to the viewport, so look it up from the document.
    const stack = within(await within(document.body).findByTestId('snackbar'));
    const message = await stack.findByRole('status');
    const error = await stack.findByRole('alert');
    expect(message).toHaveTextContent(MESSAGE);
    expect(message.getBoundingClientRect().width).toBeGreaterThan(0);
    const edge = (el: HTMLElement) => parseFloat(getComputedStyle(el).borderLeftWidth);
    expect(edge(message)).toBeLessThan(edge(error));
    await userEvent.click(within(message).getByRole('button', { name: /dismiss/i }));
    await waitFor(() => expect(stack.queryByRole('status')).toBeNull());
    expect(stack.getByRole('alert')).toHaveTextContent(ERRORS[0]);
  },
};

/** The channel dropping and coming back, as the adapter would report it. */
function Channel() {
  const send = useAppSend();
  return (
    <div style={{ display: 'flex', gap: 8, padding: 12 }}>
      <button type="button" onClick={() => send({ type: 'TMUX_RECONNECTING' })}>
        drop
      </button>
      <button type="button" onClick={() => send({ type: 'TMUX_RECONNECTED' })}>
        back
      </button>
    </div>
  );
}

export const ReconnectingAfterTwoSeconds: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'The channel drops with a session on screen. For two seconds nothing is shown — a drop that heals at once is never seen. Past that, a notice in the corner: a spinner, "Reconnecting…", and "Retry now". No overlay, no blur: the panes stay in view and usable. The notice leaves on its own when the channel is back.',
      },
    },
  },
  render: () => (
    <FixtureProvider height={320} fixture={PANES} start="one">
      <Channel />
      <Snackbar />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(document.body);
    const droppedAt = Date.now();
    await userEvent.click(canvas.getByRole('button', { name: 'drop' }));
    // Quiet first: well inside the delay there is nothing to see.
    await new Promise((r) => setTimeout(r, RECONNECT_NOTICE_DELAY_MS / 2));
    expect(body.queryByTestId('reconnect-notice')).toBeNull();
    expect(document.querySelector('[data-testid="loading-display"]')).toBeNull();
    const notice = await waitFor(
      () => {
        const el = body.getByTestId('reconnect-notice');
        expect(el).toBeVisible();
        return el;
      },
      { timeout: RECONNECT_NOTICE_DELAY_MS + 2000 },
    );
    expect(Date.now() - droppedAt).toBeGreaterThanOrEqual(RECONNECT_NOTICE_DELAY_MS - 50);
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent('Reconnecting…');
    expect(notice.querySelector('.connection-spinner')).not.toBeNull();
    expect(within(notice).getByRole('button', { name: 'Retry now' })).toBeVisible();
    // A card in the corner, not a wall: nothing covers the fixture's panes.
    const rect = notice.getBoundingClientRect();
    expect(rect.width).toBeLessThan(window.innerWidth / 2);
    expect(document.querySelector('.connection-overlay-scrim')).toBeNull();

    await userEvent.click(canvas.getByRole('button', { name: 'back' }));
    await waitFor(() => expect(body.queryByTestId('reconnect-notice')).toBeNull());
  },
};
