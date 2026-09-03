/**
 * ConnectionOverlay stories — the three looks of the pane area while nothing
 * live is on it: first load, a dropped channel over the last frame, and a
 * fatal with the log behind "Details".
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent } from 'storybook/test';
import { ConnectionOverlay } from './ConnectionOverlay';

const log = [
  {
    timestamp: 1_700_000_000_000,
    kind: 'command' as const,
    message: 'get_initial_state cols=120 rows=40',
  },
  { timestamp: 1_700_000_000_400, kind: 'error' as const, message: 'SSE closed: server stopped' },
];

/** A stand-in for the last frame of the pane grid, to blur under the overlay. */
function Snapshot() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: '0 12px 4px',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 4,
        fontFamily: 'var(--font-mono, monospace)',
        color: 'var(--text-primary, #ddd)',
      }}
    >
      {['❯ cargo watch -x run', '❯ npm test'].map((line) => (
        <div
          key={line}
          style={{ outline: '1px solid #3d3d3d', background: '#000', padding: '24px 8px' }}
        >
          {line}
        </div>
      ))}
    </div>
  );
}

const meta: Meta<typeof ConnectionOverlay> = {
  title: 'Components/ConnectionOverlay',
  component: ConnectionOverlay,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, { args }) => (
      <div
        className="pane-container"
        style={{ position: 'relative', height: 420, background: '#000' }}
      >
        {args.hasLayout && <Snapshot />}
        <Story />
      </div>
    ),
  ],
  args: { error: null, fatalError: null, log, onRetry: () => {} },
};
export default meta;
type Story = StoryObj<typeof ConnectionOverlay>;

export const Connecting: Story = {
  args: { mode: 'connecting', hasLayout: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overlay = canvas.getByTestId('loading-display');
    expect(overlay).toHaveAttribute('data-mode', 'connecting');
    expect(overlay.querySelector('.connection-placeholder')).not.toBeNull();
    expect(canvas.getByText('Connecting…')).toBeVisible();
    expect(canvas.queryByTestId('status-log')).toBeNull();
    expect(canvas.queryByText('Details')).toBeNull();
  },
};

export const ReconnectingOverSnapshot: Story = {
  args: { mode: 'reconnecting', hasLayout: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const overlay = canvas.getByTestId('loading-display');
    expect(overlay).toHaveAttribute('data-mode', 'reconnecting');
    // The snapshot is the backdrop and the scrim blurs it; the overlay spans
    // the whole pane area so nothing underneath is clickable.
    expect(overlay.querySelector('.connection-placeholder')).toBeNull();
    const scrim = overlay.querySelector('.connection-overlay-scrim') as HTMLElement;
    expect(getComputedStyle(scrim).backdropFilter).toContain('blur');
    const o = overlay.getBoundingClientRect();
    const c = canvasElement.querySelector('.pane-container')!.getBoundingClientRect();
    expect(Math.abs(o.width - c.width)).toBeLessThan(2);
    expect(Math.abs(o.height - c.height)).toBeLessThan(2);
    expect(canvas.getByText('Connecting…')).toBeVisible();
  },
};

export const Fatal: Story = {
  args: { mode: 'fatal', hasLayout: true, fatalError: 'tmux server exited (control mode closed)' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByTestId('fatal-display')).toHaveAttribute('data-mode', 'fatal');
    expect(canvas.getByText('tmux server exited (control mode closed)')).toBeVisible();
    expect(canvas.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The log is there but collapsed until the user asks for it.
    const details = canvasElement.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await userEvent.click(canvas.getByText('Details'));
    expect(details.open).toBe(true);
    expect(canvas.getByTestId('status-log')).toHaveTextContent('SSE closed: server stopped');
  },
};
