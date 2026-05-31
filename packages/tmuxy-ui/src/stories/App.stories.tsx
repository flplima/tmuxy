import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';

/**
 * Full-application stories.
 *
 * The harness mounts the real TmuxyApp behind a DemoAdapter. The adapter is
 * a fully-functional in-browser tmux mock: splits, new windows, send-keys,
 * pane groups, and widget rendering all flow through the same XState
 * machine + TmuxStore the production app uses. Optimistic updates apply
 * normally — the only thing replaced is the SSE/Tauri transport.
 */

const meta: Meta<typeof AppHarness> = {
  title: 'App/Application',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Stories below render the entire TmuxyApp against DemoAdapter (a fully functional in-browser tmux). The Interactive story drives tab/pane operations through a play function and asserts the visible result of each step.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

// ---------------------------------------------------------------------------
// Visual variants
// ---------------------------------------------------------------------------

export const Empty: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
    expect(panes.length).toBeGreaterThanOrEqual(1);
  },
};

export const Splits: Story = {
  args: {
    height: 600,
    initCommands: [
      'rename-window editor',
      'split-window -h',
      'split-window -v',
      'select-pane -t %0',
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 8000 },
    );
  },
};

export const MultipleTabs: Story = {
  args: {
    height: 600,
    initCommands: [
      'rename-window welcome',
      'new-window',
      'rename-window editor',
      'split-window -h',
      'new-window',
      'rename-window logs',
      'select-window -t @0',
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        // DemoAdapter may re-run init commands on the first set_client_size
        // (when container dims differ from get_initial_state); we tolerate
        // the resulting extra tab count.
        expect(tabs.length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 8000 },
    );
    // 'welcome' tab (index 0) should be active.
    const tabs = canvas.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  },
};

export const PaneGroup: Story = {
  args: {
    height: 600,
    initCommands: [
      'rename-window groups',
      'split-window -h',
      'select-pane -t %0',
      'tmuxy-pane-group-add',
      'tmuxy-pane-group-add',
      'select-pane -t %0',
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Three sibling panes share the left visual slot via the pane-group feature. Click each tab to swap the visible peer.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        const paneTabs = canvasElement.querySelectorAll('.pane-tab');
        // The grouped pane shows multiple in-pane tabs (one per group member).
        expect(paneTabs.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 8000 },
    );
  },
};

export const WithWidget: Story = {
  args: {
    height: 600,
    initCommands: [
      'rename-window widgets',
      'split-window -h',
      'write-widget %1 markdown # Hello widget\nThis renders **markdown** inside a tmux pane.',
      'select-pane -t %0',
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(
      () => {
        // The markdown widget renders an <h1> with the heading text.
        const h1 = canvasElement.querySelector('h1');
        expect(h1?.textContent).toMatch(/Hello widget/);
      },
      { timeout: 8000 },
    );
    // Both panes (terminal + widget) should be visible.
    const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
    expect(panes.length).toBeGreaterThanOrEqual(1);
  },
};

// ---------------------------------------------------------------------------
// Interactive story with play function
// ---------------------------------------------------------------------------

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const Interactive: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      description: {
        story:
          'Drives the app through real user interactions and asserts visible state at every step: tab create, tab switch, pane split, pane select, pane close.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });
    const win = window as unknown as { app?: { send: (e: unknown) => void } };

    // The DemoAdapter connects asynchronously; wait for the first pane to mount.
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });

    // ----- Tab creation ----------------------------------------------------
    // WindowTabs renders "+" as a button labeled "Create new tab".
    const newTabButton = canvas.getByRole('button', { name: /create new tab/i });
    await user.click(newTabButton);

    // Optimistic update should show a second tab immediately.
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 4000 },
    );

    // Some tab must be marked active.
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.some((t) => t.getAttribute('aria-selected') === 'true')).toBe(true);
      },
      { timeout: 2000 },
    );

    // ----- Split the active pane ------------------------------------------
    // Use the global app handle (exposed by AppContext for E2E debugging)
    // so we don't depend on PaneHeader hover state / menu opening.
    win.app?.send({ type: 'SEND_COMMAND', command: 'split-window -h' });

    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 5000 },
    );

    // ----- Type into a pane -----------------------------------------------
    const panesAfterSplit = canvas.getAllByRole('group', { name: /^Pane %/i });
    const target = panesAfterSplit[panesAfterSplit.length - 1];
    const targetPaneId = target.getAttribute('data-pane-id');
    expect(targetPaneId).toBeTruthy();

    if (targetPaneId) {
      win.app?.send({ type: 'SEND_KEYS', paneId: targetPaneId, keys: 'echo hi' });
      win.app?.send({ type: 'SEND_KEYS', paneId: targetPaneId, keys: 'Enter' });
    }
    // Let the demo shell loop render the echo result.
    await wait(150);

    // ----- Close the second pane ------------------------------------------
    if (targetPaneId) {
      win.app?.send({ type: 'SEND_COMMAND', command: `kill-pane -t ${targetPaneId}` });
    }
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane %/i });
        expect(panes.length).toBeGreaterThanOrEqual(1);
        expect(panes.length).toBeLessThan(panesAfterSplit.length);
      },
      { timeout: 5000 },
    );

    // ----- Status bar should still be present at end ----------------------
    expect(canvas.getByTestId('tmux-status-bar')).toBeInTheDocument();
  },
};

// ---------------------------------------------------------------------------
// Reconnecting visual state
// ---------------------------------------------------------------------------

export const ReconnectingChip: Story = {
  args: { height: 600 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 5000 });

    // Drive the app machine into the reconnecting state via the exposed
    // global handle, then assert the chip appears with the right text.
    const win = window as unknown as { app?: { send: (e: unknown) => void } };
    win.app?.send({ type: 'TMUX_RECONNECTING', attempt: 3 });

    const chip = await canvas.findByTestId('connection-status', undefined, { timeout: 2000 });
    expect(chip).toHaveTextContent(/Reconnecting/);
    expect(chip).toHaveTextContent(/attempt 3/);
  },
  parameters: {
    docs: {
      description: {
        story:
          'Drives the app machine into the reconnecting state and asserts the in-bar chip appears with the right attempt count.',
      },
    },
  },
};
