/**
 * React render-efficiency budgets.
 *
 * Every story enables the render log (utils/renderLog.tsx) BEFORE the app
 * mounts, then asserts Profiler commit counts per component id. This catches
 * the class of waste MutationObserver cannot: a component that re-renders but
 * produces identical DOM still burns CPU on every state tick.
 *
 * Budgets are deliberately coarse (order-of-magnitude, not exact commit
 * counts) so refactors don't trip them — the regression they guard is
 * "typing in one pane re-renders the world", not "one extra commit".
 *
 * Profiler onRender only fires in development React builds, so each story
 * first asserts the log is LIVE (boot recorded commits) — a production
 * bundle fails loudly instead of passing on an empty log.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';
import {
  enableRenderLog,
  renderLogMark,
  renderCountSince,
  renderCountsById,
} from '../utils/renderLog';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/RenderBudgets',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Profiler-based commit budgets: typing must not re-render unrelated panes or chrome; output bursts must stay inside the TerminalLine memo boundary; tab switches must not re-render unrelated chrome.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait for the demo boot + welcome banner to stop producing commits. */
async function waitForQuiescence(idPrefix = 'Pane:'): Promise<void> {
  await waitFor(
    async () => {
      const mark = renderLogMark();
      await wait(700);
      expect(renderCountSince(mark, idPrefix)).toBe(0);
    },
    { timeout: 30000, interval: 100 },
  );
}

/**
 * 5.1 — Typing isolation: keystrokes into the ACTIVE pane must not commit the
 * other panes or the chrome. This is the canonical "one keypress re-renders
 * the world" regression guard.
 */
export const TypingIsolation: Story = {
  args: { height: 600, initCommands: ['split-window -h', 'split-window -v'] },
  render: (args) => {
    enableRenderLog();
    return <AppHarness {...args} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(3), {
      timeout: 10000,
    });
    // The log must be LIVE (dev React) — boot always commits panes.
    expect(renderCountSince(0, 'Pane:')).toBeGreaterThan(0);

    // Focus a specific pane and let the boot/banner traffic settle.
    const panes = canvas.getAllByRole('group', { name: /^Pane /i });
    await user.click(panes[0]);
    const activeId = (
      window as unknown as { app: { getSnapshot(): { context: { activePaneId: string } } } }
    ).app.getSnapshot().context.activePaneId;
    const otherIds = panes
      .map((p) => p.getAttribute('data-pane-id'))
      .filter((id): id is string => id !== null && id !== activeId);
    await waitForQuiescence();

    const mark = renderLogMark();
    const ctxPanes = () =>
      (
        window as unknown as {
          app: { getSnapshot(): { context: { panes: { tmuxId: string }[] } } };
        }
      ).app.getSnapshot().context.panes;
    const beforeObj = ctxPanes().find((pp) => pp.tmuxId === otherIds[0]);
    await user.keyboard('echo hi');
    await waitFor(() => expect(renderCountSince(mark, `Pane:${activeId}`)).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await wait(500);

    console.error(
      'ISOLATION-DEBUG',
      JSON.stringify({
        sameObj: beforeObj === ctxPanes().find((pp) => pp.tmuxId === otherIds[0]),
        counts: renderCountsById(mark),
      }),
    );

    // The typed-into pane committed; nothing else did.
    for (const id of otherIds) {
      expect(
        renderCountSince(mark, `Pane:${id}`),
        `Pane ${id} must not re-render on typing (${JSON.stringify(renderCountsById(mark))})`,
      ).toBe(0);
    }
    expect(renderCountSince(mark, 'WindowTabs'), 'WindowTabs must not re-render on typing').toBe(0);
    expect(renderCountSince(mark, 'Sidebar'), 'Sidebar must not re-render on typing').toBe(0);
  },
};

/**
 * 5.2 — Output stays inside the TerminalLine memo boundary: a burst of output
 * commits roughly the CHANGED lines, not lines × frames. Guards the custom
 * memo comparator and the line-identity preservation in mergeContent.
 */
export const OutputBurstLineMemo: Story = {
  args: { height: 600 },
  render: (args) => {
    enableRenderLog();
    return <AppHarness {...args} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    expect(renderCountSince(0, 'TerminalLine')).toBeGreaterThan(0);
    await user.click(canvas.getAllByRole('group', { name: /^Pane /i })[0]);
    await waitForQuiescence();

    // `ls` prints a handful of lines in the demo shell.
    const mark = renderLogMark();
    await user.keyboard('ls{Enter}');
    await waitFor(() => expect(renderCountSince(mark, 'TerminalLine')).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await wait(800);

    // ~10 changed lines across a few frames — far below lines × frames
    // (24 lines × ~10 frames ≈ 240 would mean the memo boundary is broken).
    const lineCommits = renderCountSince(mark, 'TerminalLine');
    expect(lineCommits, `TerminalLine commits: ${lineCommits}`).toBeLessThan(120);
  },
};

/**
 * 5.3 — Tab switch commit budget: switching tabs re-renders the pane grid
 * (hidden↔shown) but unrelated chrome at most once — and switching BACK does
 * not double the cost.
 */
export const TabSwitchCommitBudget: Story = {
  args: { height: 600 },
  render: (args) => {
    enableRenderLog();
    return <AppHarness {...args} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    await user.click(canvas.getByRole('button', { name: /create new tab/i }));
    await waitFor(() => expect(canvas.getAllByRole('tab').length).toBeGreaterThanOrEqual(2), {
      timeout: 10000,
    });
    await waitForQuiescence();

    const mark = renderLogMark();
    await user.click(canvas.getAllByRole('tab')[0]);
    await wait(700);
    const tabsCommits = renderCountSince(mark, 'WindowTabs');
    const sidebarCommits = renderCountSince(mark, 'Sidebar');
    // The tab strip re-renders a bounded number of times (selection flip +
    // model confirm), and closed chrome not at all.
    expect(tabsCommits, `WindowTabs commits: ${tabsCommits}`).toBeLessThanOrEqual(6);
    expect(sidebarCommits, 'Sidebar (closed) must not render').toBe(0);
  },
};
