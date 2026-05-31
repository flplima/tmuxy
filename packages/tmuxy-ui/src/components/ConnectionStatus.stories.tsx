import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { ConnectionStatus } from './ConnectionStatus';

const meta: Meta<typeof ConnectionStatus> = {
  title: 'Components/ConnectionStatus',
  component: ConnectionStatus,
  parameters: { layout: 'centered' },
  argTypes: {
    reconnecting: { control: 'boolean' },
    reconnectAttempt: { control: { type: 'number', min: 0, max: 20 } },
  },
};
export default meta;
type Story = StoryObj<typeof ConnectionStatus>;

export const Hidden: Story = {
  args: { reconnecting: false, reconnectAttempt: 0 },
  parameters: {
    docs: { description: { story: 'When not reconnecting, the chip renders nothing.' } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByTestId('connection-status')).toBeNull();
  },
};

export const FirstAttempt: Story = {
  args: { reconnecting: true, reconnectAttempt: 1 },
  parameters: {
    docs: {
      description: {
        story: 'On attempt 1 the chip omits the `(attempt N)` suffix to stay calm.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByTestId('connection-status');
    expect(chip).toHaveTextContent(/Reconnecting/);
    // Attempt 1 must NOT show "(attempt N)"
    expect(chip).not.toHaveTextContent(/attempt/);
  },
};

export const Retrying: Story = {
  args: { reconnecting: true, reconnectAttempt: 4 },
  parameters: {
    docs: {
      description: {
        story: 'After repeated retries the chip shows the attempt count to signal escalation.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByTestId('connection-status');
    expect(chip).toHaveTextContent(/Reconnecting/);
    expect(chip).toHaveTextContent(/attempt 4/);
    expect(chip).toHaveAttribute('role', 'status');
    expect(chip).toHaveAttribute('aria-live', 'polite');
  },
};
