// The UI under hostile timing and errors from the tmux actor, over states
// recorded from real tmux. The slow and rejected split are Animations ›
// SlowSplitOptimistic and SplitRejectedRollback.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import oneTabThenTwo from './fixtures/gen/one-tab-then-two.json';
import { wait } from './animationObservers';
import { appContext, storyApp } from './storyApp';

const NEW_TAB = [{ match: /^new-window\b/, to: 'two-tabs' }];
const KILL = [{ match: /^kill-pane\b/, to: 'one' }];
const SPLIT = [{ match: /^split-window\b/, to: 'side-by-side' }];

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Resilience',
  component: FixtureApp,
  args: { fixture: asFixture(oneTabThenTwo), start: 'one-tab', transitions: NEW_TAB },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Stories that stress the optimistic-update path over a recording of real tmux: slow tmux responses (the optimistic patch must stay visible) and rejected commands (the patch must roll back).',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

export const SlowTabCreate: Story = {
  args: { commandDelayMs: 250 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'new-window takes 250ms to ack. The optimistic tab must appear immediately and stay visible — no disappearing-then-reappearing.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });

    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const beforeTabs = canvas.getAllByRole('tab').length;

    const newTabButton = canvas.getByRole('button', { name: /create new tab/i });
    await user.click(newTabButton);

    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBe(beforeTabs + 1);
      },
      { timeout: 200 },
    );

    for (let i = 0; i < 5; i++) {
      const tabs = canvas.getAllByRole('tab');
      expect(tabs.length).toBe(beforeTabs + 1);
      await wait(40);
    }

    await wait(150);
    expect(canvas.getAllByRole('tab').length).toBe(beforeTabs + 1);
  },
};

export const TabCreateRejected: Story = {
  args: {
    commandDelayMs: 60,
    failCommand: (cmd) => (cmd.startsWith('new-window') ? 'session limit reached' : false),
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Backend rejects new-window. The optimistic tab appears, then disappears once the rejection arrives. Subsequent interactions still work — the app survives the rejection.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup({ delay: 5 });

    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const beforeTabs = canvas.getAllByRole('tab').length;

    // The optimistic tab lives ~60ms, so a polling waitFor misses it on a loaded
    // machine; a MutationObserver's records are queued synchronously.
    let maxTabs = beforeTabs;
    const observer = new MutationObserver(() => {
      maxTabs = Math.max(maxTabs, canvas.queryAllByRole('tab').length);
    });
    observer.observe(canvasElement, { childList: true, subtree: true, attributes: true });

    const newTabButton = canvas.getByRole('button', { name: /create new tab/i });
    await user.click(newTabButton);

    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBe(beforeTabs);
      },
      { timeout: 1500 },
    );
    observer.disconnect();

    expect(maxTabs).toBe(beforeTabs + 1);

    const tabsAfter = canvas.getAllByRole('tab');
    expect(tabsAfter.some((t) => t.getAttribute('aria-selected') === 'true')).toBe(true);
  },
};

export const SlowKillPane: Story = {
  args: {
    fixture: asFixture(panes),
    start: 'side-by-side',
    transitions: KILL,
    commandDelayMs: 800,
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'kill-pane takes 800ms to ack. The optimistic KillPane prediction removes the pane on dispatch (after the 300ms exit-animation grace), long before the ack — and the count must stay at 1 through the confirmation.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const paneCount = () => canvas.getAllByRole('group', { name: /^Pane /i }).length;

    await waitFor(() => expect(paneCount()).toBe(2), { timeout: 8000 });
    storyApp().send({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane' });

    await waitFor(() => expect(paneCount()).toBe(1), { timeout: 600 });

    for (let i = 0; i < 6; i++) {
      expect(paneCount()).toBe(1);
      await wait(80);
    }
  },
};

export const KillPaneRejected: Story = {
  args: {
    fixture: asFixture(panes),
    start: 'side-by-side',
    transitions: KILL,
    commandDelayMs: 60,
    failCommand: (cmd) => (cmd.startsWith('kill-pane') ? "can't kill pane: busy" : false),
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Backend rejects kill-pane. The rejection lands inside the 300ms exit-animation grace, so the rollback replaces the deferred update before anything visibly disappears: the pane count must NEVER drop below 2, and the error must surface.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const paneCount = () => canvas.getAllByRole('group', { name: /^Pane /i }).length;

    await waitFor(() => expect(paneCount()).toBe(2), { timeout: 8000 });
    storyApp().send({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane' });

    // Keeps sampling until the rejection has surfaced rather than for a fixed
    // stretch: on a loaded machine the round trip outlived a fixed window.
    const rejected = () => appContext().notifications.length > 0;
    for (let i = 0; i < 120 && !rejected(); i++) {
      expect(paneCount(), 'the pane disappeared before the rejection landed').toBe(2);
      await wait(70);
    }
    expect(rejected(), 'the rejection never reached the user').toBe(true);
    expect(paneCount()).toBe(2);
  },
};

// An in-flight op outlasting the quick stale sweep must not blink away; the
// placeholder persists and morphs when the ack lands.

export const SlowAckKeepsPlaceholder: Story = {
  tags: ['nightly'],
  args: { fixture: asFixture(panes), start: 'one', transitions: SPLIT, commandDelayMs: 3000 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          "The backend takes 3s to ack a split — longer than OP_STALE_TIMEOUT_MS (2s). The op is `in-flight` (its adapter call is still running), so the quick sweep must NOT touch it: a server snapshot arriving past the timeout keeps the placeholder on screen — sweeping would blink the user's split away and remount it exactly when the backend is slowest. When the late ack lands, the placeholder morphs into the REAL pane in place. A truly lost ack still falls to the acked-stale backstop (OP_ACKED_STALE_TIMEOUT_MS).",
      },
    },
  },
  render: (args) => (
    <FixtureApp
      {...args}
      onAdapterReady={(adapter) => {
        (window as unknown as { __staleAdapter?: FixtureAdapter }).__staleAdapter = adapter;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const win = window as unknown as { __staleAdapter?: FixtureAdapter };
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(1);

    storyApp().send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2), {
      timeout: 200,
    });

    // Past the quick stale timeout a server snapshot still showing 1 pane
    // arrives; the op is in flight, so the placeholder must survive.
    await wait(2200);
    win.__staleAdapter!.emitStateSnapshot();
    await wait(300);
    expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2);

    await waitFor(
      () => {
        const groups = canvas.getAllByRole('group', { name: /^Pane /i });
        expect(groups.length).toBe(2);
        expect(groups.every((p) => /^%\d+$/.test(p.getAttribute('data-pane-id') ?? ''))).toBe(true);
        expect(storyApp().view().activePaneId).toMatch(/^%\d+$/);
      },
      { timeout: 5000 },
    );
  },
};
