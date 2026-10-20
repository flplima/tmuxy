/**
 * Resilience stories — verify the UI behaves well under hostile timing /
 * error conditions in the tmux actor, over states recorded from real tmux:
 *
 * - SlowTabCreate: backend takes 250ms to ack a `new-window`. The optimistic
 *   tab must appear at once and not blink while we wait.
 * - TabCreateRejected: backend rejects `new-window`. The optimistic tab must
 *   disappear and the active tab fall back to a real one.
 * - SlowKillPane / KillPaneRejected: the same two shapes for `kill-pane`.
 * - SlowAckKeepsPlaceholder: a split acked after the quick stale timeout
 *   keeps its placeholder through a server snapshot, then morphs into the
 *   real pane.
 *
 * The slow and rejected split are Scenarios/Animations › SlowSplitOptimistic
 * and SplitRejectedRollback.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import panes from './fixtures/gen/panes.json';
import oneTabThenTwo from './fixtures/gen/one-tab-then-two.json';
import { PaneId } from '../domain/ids';

/** A new tab answered with the two tabs tmux drew, the new one current. */
const NEW_TAB = [{ match: /^new-window\b/, to: 'two-tabs' }];
/** A kill answered with the one pane left. */
const KILL = [{ match: /^kill-pane\b/, to: 'one' }];
/** A split answered with the two panes tmux drew. */
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

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Slow tmux responses — optimistic UI must remain stable while we wait
// ---------------------------------------------------------------------------

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

    // Optimistic patch should add a tab immediately.
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBe(beforeTabs + 1);
      },
      { timeout: 200 },
    );

    // Tab count must stay stable while we wait for the slow ack.
    for (let i = 0; i < 5; i++) {
      const tabs = canvas.getAllByRole('tab');
      expect(tabs.length).toBe(beforeTabs + 1);
      await wait(40);
    }

    // After the ack, still the same count.
    await wait(150);
    expect(canvas.getAllByRole('tab').length).toBe(beforeTabs + 1);
  },
};

// ---------------------------------------------------------------------------
// Error responses — optimistic UI must roll back cleanly
// ---------------------------------------------------------------------------

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

    // The optimistic tab lives only ~60ms (until the rejection lands), so a
    // polling waitFor misses it on a loaded machine — record the peak tab
    // count with a MutationObserver instead (mutation records are queued
    // synchronously, independent of poll timing).
    let maxTabs = beforeTabs;
    const observer = new MutationObserver(() => {
      maxTabs = Math.max(maxTabs, canvas.queryAllByRole('tab').length);
    });
    observer.observe(canvasElement, { childList: true, subtree: true, attributes: true });

    const newTabButton = canvas.getByRole('button', { name: /create new tab/i });
    await user.click(newTabButton);

    // Rejection rolls the optimistic tab back.
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBe(beforeTabs);
      },
      { timeout: 1500 },
    );
    observer.disconnect();

    // The optimistic tab DID appear at some point before the rollback.
    expect(maxTabs).toBe(beforeTabs + 1);

    // The app is still alive — at least one tab is marked active.
    const tabsAfter = canvas.getAllByRole('tab');
    expect(tabsAfter.some((t) => t.getAttribute('aria-selected') === 'true')).toBe(true);
  },
};

// ---------------------------------------------------------------------------
// Optimistic kill-pane — removal on click, rollback on rejection
// ---------------------------------------------------------------------------

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
    const win = window as unknown as { app?: { send: (e: unknown) => void } };
    const paneCount = () => canvas.getAllByRole('group', { name: /^Pane /i }).length;

    await waitFor(() => expect(paneCount()).toBe(2), { timeout: 8000 });
    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane' });

    // Optimistic removal applies immediately (no removingPane hold),
    // well before the 800ms ack.
    await waitFor(() => expect(paneCount()).toBe(1), { timeout: 600 });

    // Stays gone through the ack — no flicker back to 2.
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
    const win = window as unknown as {
      app?: {
        send: (e: unknown) => void;
        getSnapshot(): { context: { notifications: { text: string }[] } };
      };
    };
    const paneCount = () => canvas.getAllByRole('group', { name: /^Pane /i }).length;

    await waitFor(() => expect(paneCount()).toBe(2), { timeout: 8000 });
    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane' });

    // Sample through the rejection window: the pane never visibly disappears.
    // The loop is the assertion, so it keeps sampling until the rejection has
    // actually surfaced rather than for a fixed stretch — on a loaded machine
    // the round trip outlived the old ten-sample window and the story failed
    // on a notification that had simply not arrived yet.
    const rejected = () => win.app!.getSnapshot().context.notifications.length > 0;
    for (let i = 0; i < 120 && !rejected(); i++) {
      expect(paneCount(), 'the pane disappeared before the rejection landed').toBe(2);
      await wait(70);
    }
    // The rejection reaches the user as a snackbar entry.
    expect(rejected(), 'the rejection never reached the user').toBe(true);
    // ...and the rollback left both panes standing.
    expect(paneCount()).toBe(2);
  },
};

// ---------------------------------------------------------------------------
// Slow-ack survival — an in-flight op outlasting the quick sweep must NOT
// blink away; the placeholder persists and morphs when the ack lands
// ---------------------------------------------------------------------------

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
    const win = window as unknown as {
      app?: { send: (e: unknown) => void; getSnapshot(): { context: { activePaneId: PaneId } } };
      __staleAdapter?: FixtureAdapter;
    };
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(1);

    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });
    // The optimistic patch lands immediately.
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2), {
      timeout: 200,
    });

    // Past the quick stale timeout, a server snapshot (still showing 1 pane —
    // the delayed command hasn't executed) arrives. The op is in-flight, so
    // the placeholder must SURVIVE: no blink-out-and-remount.
    await wait(2200);
    win.__staleAdapter!.emitStateSnapshot();
    await wait(300);
    expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2);

    // The late ack executes: the placeholder morphs into the REAL pane —
    // still 2 panes, real ids only, focus sane.
    await waitFor(
      () => {
        const groups = canvas.getAllByRole('group', { name: /^Pane /i });
        expect(groups.length).toBe(2);
        expect(groups.every((p) => /^%\d+$/.test(p.getAttribute('data-pane-id') ?? ''))).toBe(true);
        expect(win.app!.getSnapshot().context.activePaneId).toMatch(/^%\d+$/);
      },
      { timeout: 5000 },
    );
  },
};
