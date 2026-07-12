/**
 * ServerPicker stories (component-level, no Tauri runtime).
 *
 * The picker is presentational — data + callbacks are props — so it renders and
 * behaves identically in Storybook. These stories exercise the real user chain:
 * click the footer → popover lists servers (current one checked) → clicking a
 * server calls onSelect, "Add server…" calls onAddServer.
 */
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { ServerPicker } from './ServerPicker';
import type { ServerInfo } from '../machines/types';

const meta: Meta<typeof ServerPicker> = {
  title: 'Components/ServerPicker',
  component: ServerPicker,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof ServerPicker>;

const SERVERS: ServerInfo[] = [
  { id: 'localhost', label: 'localhost', kind: 'local' },
  { id: 'ssh-box', label: 'felipe@box', kind: 'ssh' },
  { id: 'local-default', label: 'default', kind: 'local' },
];

const Demo = ({ servers = SERVERS }: { servers?: ServerInfo[] }) => {
  const [current, setCurrent] = useState('localhost');
  const [added, setAdded] = useState(0);
  return (
    // Mimic the sidebar column so the footer/popover position realistically.
    <div
      style={{ height: '100vh', display: 'flex', flexDirection: 'column', width: 280 }}
      className="sidebar-fixed"
    >
      <div style={{ flex: 1 }} />
      <div data-testid="current-id">{current}</div>
      <div data-testid="added-count">{added}</div>
      <ServerPicker
        servers={servers}
        currentId={current}
        onSelect={setCurrent}
        onAddServer={() => setAdded((n) => n + 1)}
      />
    </div>
  );
};

export const SwitchAndAdd: Story = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Resting label shows the current server.
    const toggle = canvas.getByTestId('server-picker-toggle');
    expect(toggle.textContent).toContain('localhost');

    // Open the popover → all servers listed, current one flagged.
    await userEvent.click(toggle);
    const menu = await waitFor(() => canvas.getByTestId('server-picker-menu'));
    expect(within(menu).getByTestId('server-picker-item-ssh-box')).toBeInTheDocument();
    expect(canvas.getByTestId('server-picker-item-localhost').className).toContain('is-current');

    // Pick another server → onSelect fires, footer updates, popover closes.
    await userEvent.click(canvas.getByTestId('server-picker-item-ssh-box'));
    await waitFor(() => expect(canvas.getByTestId('current-id').textContent).toBe('ssh-box'));
    expect(canvas.queryByTestId('server-picker-menu')).toBeNull();
    expect(canvas.getByTestId('server-picker-toggle').textContent).toContain('felipe@box');

    // Reopen and use "Add server…" → onAddServer fires, popover closes.
    await userEvent.click(canvas.getByTestId('server-picker-toggle'));
    await waitFor(() => canvas.getByTestId('server-picker-menu'));
    await userEvent.click(canvas.getByTestId('server-picker-add'));
    await waitFor(() => expect(canvas.getByTestId('added-count').textContent).toBe('1'));
    expect(canvas.queryByTestId('server-picker-menu')).toBeNull();
  },
};

export const MenuOpen: Story = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    // Open the popover and leave it open (for a visual of the full menu).
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('server-picker-toggle'));
    await waitFor(() => canvas.getByTestId('server-picker-menu'));
  },
};

export const ClosesOnOutsideClick: Story = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('server-picker-toggle'));
    await waitFor(() => canvas.getByTestId('server-picker-menu'));
    // Click outside the picker → popover closes.
    await userEvent.click(canvas.getByTestId('current-id'));
    await waitFor(() => expect(canvas.queryByTestId('server-picker-menu')).toBeNull());
  },
};
