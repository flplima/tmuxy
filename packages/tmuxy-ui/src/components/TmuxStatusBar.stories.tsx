import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor } from 'storybook/test';
import { TmuxStatusBar } from './TmuxStatusBar';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof TmuxStatusBar> = {
  title: 'Components/TmuxStatusBar',
  component: TmuxStatusBar,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof TmuxStatusBar>;

export const Default: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <TmuxStatusBar />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    // Session hostname segment renders even when no live commands have run.
    const host = bar.querySelector('.statusline-host');
    expect(host).not.toBeNull();
    expect(host).toHaveClass('statusline-clickable');
  },
};

export const Demo: Story = {
  render: () => (
    <ProviderHarness height={60} config={{ isDemo: true }}>
      <TmuxStatusBar />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'With `isDemo`, the hostname / session segments lose their click handlers (no SSH or session switcher in the demo site).',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const bar = await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    const host = bar.querySelector('.statusline-host');
    expect(host).not.toBeNull();
    // In demo mode the click handler is dropped, so the clickable class is gone.
    expect(host).not.toHaveClass('statusline-clickable');
    expect(host).toHaveTextContent(/demo@localhost/);
  },
};

/** The bar's box, whichever line it is drawing. */
const barBox = (canvasElement: HTMLElement) => {
  const bar = canvasElement.querySelector(
    '[data-testid="tmux-status-bar"], [data-testid="tmux-command-mode"]',
  );
  const box = bar?.getBoundingClientRect();
  return box ? { top: box.top, height: box.height } : null;
};

/**
 * The bar keeps one height in every mode. It used to be as tall as its tallest
 * item: the host and session labels in normal mode, the hint row alone in a
 * mode, the prompt with its padding at `:`, so it moved by a few pixels on
 * every prefix press.
 */
export const SameHeightInEveryMode: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <TmuxStatusBar />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => canvas.getByTestId('tmux-status-bar'), { timeout: 5000 });
    const send = (event: Record<string, unknown>) =>
      (window as unknown as { app: { send(e: Record<string, unknown>): void } }).app.send(event);
    const normal = barBox(canvasElement);
    expect(normal?.height).toBeGreaterThan(0);

    const states: Array<[string, Record<string, unknown>, string]> = [
      ['prefix', { type: 'PREFIX_MODE_CHANGE', active: true }, 'prefix'],
      ['pane table', { type: 'KEY_TABLE_CHANGE', table: 'pane' }, 'pane'],
    ];
    for (const [name, event, mode] of states) {
      send(event);
      await waitFor(() =>
        expect(canvasElement.querySelector(`[data-key-mode="${mode}"]`)).not.toBeNull(),
      );
      expect(barBox(canvasElement), name).toEqual(normal);
    }
    send({ type: 'KEY_TABLE_CHANGE', table: null });
    send({ type: 'PREFIX_MODE_CHANGE', active: false });

    send({ type: 'OPEN_COMMAND_PROMPT', prompt: null, initial: '', template: null });
    await waitFor(() => expect(canvas.getByTestId('tmux-command-mode')).toBeInTheDocument());
    expect(barBox(canvasElement), 'command prompt').toEqual(normal);
    send({ type: 'COMMAND_MODE_CANCEL' });
    await waitFor(() => expect(canvas.getByTestId('tmux-status-bar')).toBeInTheDocument());
    expect(barBox(canvasElement), 'back to normal').toEqual(normal);
  },
};
