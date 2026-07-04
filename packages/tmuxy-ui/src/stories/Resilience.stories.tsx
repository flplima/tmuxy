/**
 * Resilience stories — verify the UI behaves well under hostile timing /
 * error conditions in the tmux actor:
 *
 * - SlowSplit: backend takes 300ms to ack a `split-window`. The optimistic
 *   patch must show the new pane immediately and the count must stay stable
 *   throughout — i.e. no flicker back to one pane while we wait.
 * - SlowTabCreate: same shape for `new-window`. Verifies SELECT_TAB-class
 *   optimistic flows don't blink during slow ack.
 * - SplitRejected: backend rejects `split-window` with stderr. The optimistic
 *   patch must roll back and the pane count return to the pre-click value.
 * - TabCreateRejected: same shape for `new-window`. The optimistic tab must
 *   disappear and the active tab fall back to a real one.
 * - SteadyStreamNoBlink: simulates a Gemini-CLI-style clear+redraw burst
 *   (sequential `write-widget` updates) and asserts no transient empty
 *   pane is rendered between updates.
 * - ClipboardOSC52: drives the DemoAdapter's `emitClipboard` helper and
 *   verifies the appMachine forwarded the payload via the test escape hatch.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import type { DemoAdapter } from '../lib';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Resilience',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Stories that stress the optimistic-update path: slow tmux responses (the optimistic patch must stay visible) and rejected commands (the patch must roll back). Also covers OSC 52 clipboard plumbing and the anti-blink coalescing for full-screen redraws.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Slow tmux responses — optimistic UI must remain stable while we wait
// ---------------------------------------------------------------------------

export const SlowSplit: Story = {
  args: { height: 600, commandDelayMs: 300 },
  parameters: {
    docs: {
      story: {
        inline: false,
        iframeHeight: 600,
      },
      description: {
        story:
          'split-window takes 300ms to ack. The optimistic patch must show the new pane immediately (via the TmuxStore predict() path) and the count must stay at 2 throughout, never blinking back to 1.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const win = window as unknown as { app?: { send: (e: unknown) => void } };

    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const before = canvas.getAllByRole('group', { name: /^Pane /i }).length;
    expect(before).toBe(1);

    // SEND_TMUX_COMMAND routes through TmuxStore.dispatch (optimistic predict
    // → command → reconcile). SEND_COMMAND bypasses the store and waits for
    // the server snapshot, which would defeat the test under commandDelayMs.
    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

    // Optimistic patch should bring us to 2 panes within one rAF.
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane /i });
        expect(panes.length).toBe(2);
      },
      { timeout: 200 },
    );

    // Sample the count repeatedly while the backend is still processing the
    // 300ms-delayed command. If the optimistic patch ever flickers back, we
    // catch it here.
    for (let i = 0; i < 6; i++) {
      const panes = canvas.getAllByRole('group', { name: /^Pane /i });
      expect(panes.length).toBe(2);
      await wait(40);
    }

    // After the backend acks, the count must still be 2 (now from the server
    // snapshot, not the optimistic patch).
    await wait(250);
    const after = canvas.getAllByRole('group', { name: /^Pane /i }).length;
    expect(after).toBe(2);
  },
};

export const SlowTabCreate: Story = {
  args: { height: 600, commandDelayMs: 250 },
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

export const SplitRejected: Story = {
  args: {
    height: 600,
    commandDelayMs: 60,
    failCommand: (cmd) => (cmd.startsWith('split-window') ? "can't split pane: no space" : false),
  },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'Backend rejects split-window with "no space". The optimistic patch flashes briefly then rolls back. After the ack, the pane count must return to its pre-click value.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const win = window as unknown as { app?: { send: (e: unknown) => void } };

    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    const before = canvas.getAllByRole('group', { name: /^Pane /i }).length;
    expect(before).toBe(1);

    // SEND_TMUX_COMMAND goes through the store so the optimistic patch lands
    // synchronously and the rejection can later roll it back via reconcile.
    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });

    // Optimistic patch is applied first.
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane /i });
        expect(panes.length).toBe(2);
      },
      { timeout: 200 },
    );

    // Then rolled back after the rejection arrives.
    await waitFor(
      () => {
        const panes = canvas.getAllByRole('group', { name: /^Pane /i });
        expect(panes.length).toBe(1);
      },
      { timeout: 1000 },
    );
  },
};

export const TabCreateRejected: Story = {
  args: {
    height: 600,
    commandDelayMs: 60,
    failCommand: (cmd) =>
      cmd.startsWith('new-window') || cmd.includes('splitw') ? 'session limit reached' : false,
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

    const newTabButton = canvas.getByRole('button', { name: /create new tab/i });
    await user.click(newTabButton);

    // Optimistic patch adds the tab.
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBe(beforeTabs + 1);
      },
      { timeout: 250 },
    );

    // Rejection rolls it back.
    await waitFor(
      () => {
        const tabs = canvas.getAllByRole('tab');
        expect(tabs.length).toBe(beforeTabs);
      },
      { timeout: 1000 },
    );

    // The app is still alive — at least one tab is marked active.
    const tabsAfter = canvas.getAllByRole('tab');
    expect(tabsAfter.some((t) => t.getAttribute('aria-selected') === 'true')).toBe(true);
  },
};

// ---------------------------------------------------------------------------
// Optimistic kill-pane — removal on click, rollback on rejection
// ---------------------------------------------------------------------------

export const SlowKillPane: Story = {
  args: { height: 600, commandDelayMs: 800, initCommands: ['split-window -h'] },
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

    // Optimistic removal: gone within the 300ms removingPane grace + margin,
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
    height: 600,
    commandDelayMs: 60,
    initCommands: ['split-window -h'],
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
      app?: { send: (e: unknown) => void; getSnapshot(): { context: { error: string | null } } };
    };
    const paneCount = () => canvas.getAllByRole('group', { name: /^Pane /i }).length;

    await waitFor(() => expect(paneCount()).toBe(2), { timeout: 8000 });
    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'kill-pane' });

    // Sample through the rejection window: the pane never visibly disappears.
    for (let i = 0; i < 10; i++) {
      expect(paneCount()).toBe(2);
      await wait(70);
    }
    expect(win.app!.getSnapshot().context.error).toBeTruthy();
  },
};

// ---------------------------------------------------------------------------
// Stale-op sweeper — a pending op may never be confirmed; it must not wedge
// ---------------------------------------------------------------------------

export const StaleOpSweep: StoryObj<ClipboardArgs & { commandDelayMs?: number }> = {
  args: { height: 600, commandDelayMs: 3000 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'The backend takes 3s to ack a split — longer than OP_STALE_TIMEOUT_MS (2s). When a server snapshot arrives past the timeout, the sweeper must drop the stale placeholder (UI returns to the committed state, focus not wedged on a placeholder id). When the late command finally executes, the REAL pane appears. Guards against a lost ack freezing the optimistic layer forever.',
      },
    },
  },
  render: (args) => (
    <AppHarness
      {...args}
      onAdapterReady={(adapter) => {
        (window as unknown as { __staleAdapter?: DemoAdapter }).__staleAdapter = adapter;
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const win = window as unknown as {
      app?: { send: (e: unknown) => void; getSnapshot(): { context: { activePaneId: string } } };
      __staleAdapter?: DemoAdapter;
    };
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(1);

    win.app?.send({ type: 'SEND_TMUX_COMMAND', command: 'split-window -h' });
    // The optimistic patch lands immediately.
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2), {
      timeout: 200,
    });

    // Past the stale timeout, a server snapshot (still showing 1 pane —
    // the delayed command hasn't executed) must sweep the placeholder.
    await wait(2200);
    win.__staleAdapter!.emitStateSnapshot();
    await waitFor(
      () => {
        expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(1);
        expect(win.app!.getSnapshot().context.activePaneId).toMatch(/^%\d+$/);
      },
      { timeout: 1000 },
    );

    // The late ack finally executes: the REAL pane appears and focus is sane.
    await waitFor(
      () => {
        expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(2);
        expect(win.app!.getSnapshot().context.activePaneId).toMatch(/^%\d+$/);
      },
      { timeout: 3000 },
    );
  },
};

// ---------------------------------------------------------------------------
// Gemini-style clear+redraw — anti-blink coalescing
// ---------------------------------------------------------------------------

export const SteadyStreamNoBlink: Story = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'TUI apps like the Gemini CLI repeatedly clear and redraw the entire pane. The frontend rAF batching and the backend trailing-edge debounce together ensure the cleared intermediate state never reaches the renderer. This story waits for the demo shell to paint its welcome banner, then samples the pane content every frame for ~250ms while the demo loop keeps emitting state updates. Each sample must show the banner — if any sample is empty, the renderer briefly drew a cleared frame, which is the bug we guard against.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The demo shell paints "This is a live demo" as the welcome banner the
    // moment the pane mounts. Using that as our anchor text means we don't
    // have to type or wait for any echo round-trip — we just need to verify
    // that already-painted content never disappears under steady redraws.
    await waitFor(
      () => {
        const pane = canvas.getByRole('group', { name: /Pane %0/i });
        expect(pane.textContent || '').toMatch(/live demo/i);
      },
      { timeout: 8000 },
    );

    // Sample the pane every frame for ~250ms. The DemoTmux emits state on a
    // timer (setOnAsyncUpdate) so the anchor text passes through the same
    // delta-merge + rAF batching path Gemini CLI's clear+redraw would.
    let blinks = 0;
    for (let i = 0; i < 16; i++) {
      const pane = canvas.getByRole('group', { name: /Pane %0/i });
      const txt = (pane.textContent || '').trim();
      if (!/live demo/i.test(txt)) {
        blinks++;
      }
      await wait(16);
    }
    expect(blinks).toBe(0);
  },
};

// ---------------------------------------------------------------------------
// OSC 52 clipboard plumbing — round-trip through the appMachine
// ---------------------------------------------------------------------------

interface ClipboardArgs {
  height?: number;
  initCommands?: string[];
}

export const ClipboardOSC52: StoryObj<ClipboardArgs> = {
  args: { height: 600 },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 600 },
      description: {
        story:
          'When a terminal app emits an OSC 52 sequence (e.g. `printf "\\e]52;c;<base64>\\e\\\\"`), the backend decodes the payload and tells the frontend to mirror it into the system clipboard. This story uses the DemoAdapter `emitClipboard` helper and verifies the appMachine received the event via the `__tmuxyLastClipboard` test hook.',
      },
    },
  },
  render: (args) => {
    let live: DemoAdapter | null = null;
    return (
      <div data-osc52-harness>
        <AppHarness
          {...args}
          onAdapterReady={(adapter) => {
            live = adapter;
            // Park the live adapter on window so the play function below can
            // reach it without having to subscribe to React state.
            (window as unknown as { __osc52Adapter?: DemoAdapter }).__osc52Adapter = live;
          }}
        />
      </div>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });

    const adapter = (window as unknown as { __osc52Adapter?: DemoAdapter }).__osc52Adapter;
    expect(adapter).toBeTruthy();

    // Clear any prior test hook payload.
    const win = window as unknown as { __tmuxyLastClipboard?: { paneId: string; text: string } };
    win.__tmuxyLastClipboard = undefined;

    // Inject the clipboard write the same way the Rust backend would after
    // parsing an OSC 52 sequence.
    adapter!.emitClipboard('%0', 'gemini says hi');

    await waitFor(
      () => {
        expect(win.__tmuxyLastClipboard).toEqual({ paneId: '%0', text: 'gemini says hi' });
      },
      { timeout: 1000 },
    );
  },
};
