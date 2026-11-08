/**
 * React render budgets: Profiler commit counts per component id
 * (components/renderLog.tsx), the waste a MutationObserver cannot see. Budgets
 * are order-of-magnitude so refactors don't trip them: the regression guarded
 * is "typing in one pane re-renders the world", not "one extra commit".
 * Profiler onRender only fires in development React builds, so each story first
 * asserts the log is live; a production bundle fails instead of passing empty.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import typingThreePanes from './fixtures/gen/typing-three-panes.json';
import lsListing from './fixtures/gen/ls-listing.json';
import oneTabThenTwo from './fixtures/gen/one-tab-then-two.json';
import {
  enableRenderLog,
  renderLogMark,
  renderCountSince,
  renderCountsById,
} from '../components/renderLogStore';
import { wait } from './animationObservers';
import { storyApp } from './storyApp';

const enterShows = (state: string) => [{ match: /^send-keys -t %0 Enter$/, to: state }];

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/RenderBudgets',
  component: FixtureApp,
  render: (args) => {
    enableRenderLog();
    return <FixtureApp {...args} />;
  },
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
type Story = StoryObj<typeof FixtureApp>;

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

/** Keystrokes into the active pane must not commit the other panes or the chrome. */
export const TypingIsolation: Story = {
  tags: ['nightly'],
  args: {
    fixture: asFixture(typingThreePanes),
    start: 'three-panes',
    transitions: [{ match: /^send-keys -t %0 -l /, to: 'typed' }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitFor(() => expect(canvas.getAllByRole('group', { name: /^Pane /i }).length).toBe(3), {
      timeout: 10000,
    });
    expect(renderCountSince(0, 'Pane:')).toBeGreaterThan(0);

    const panes = canvas.getAllByRole('group', { name: /^Pane /i });
    await user.click(panes.find((p) => p.getAttribute('data-pane-id') === '%0')!);
    const activeId = storyApp().view().activePaneId;
    const otherIds = panes
      .map((p) => p.getAttribute('data-pane-id'))
      .filter((id): id is string => id !== null && id !== activeId);
    await waitForQuiescence();

    const mark = renderLogMark();
    await user.keyboard('echo hi');
    await waitFor(() => expect(renderCountSince(mark, `Pane:${activeId}`)).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await wait(500);

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
 * A burst of output commits roughly the changed lines, not lines × frames.
 * Guards TerminalLine's memo comparator and the line identity mergeSparseContent
 * (domain/deltaProtocol.ts) keeps.
 */
export const OutputBurstLineMemo: Story = {
  tags: ['nightly'],
  args: { fixture: asFixture(lsListing), start: 'prompt', transitions: enterShows('listed') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    expect(renderCountSince(0, 'TerminalLine')).toBeGreaterThan(0);
    await user.click(canvas.getAllByRole('group', { name: /^Pane /i })[0]);
    await waitForQuiescence();

    const mark = renderLogMark();
    await user.keyboard('ls{Enter}');
    await waitFor(() => expect(renderCountSince(mark, 'TerminalLine')).toBeGreaterThan(0), {
      timeout: 5000,
    });
    await wait(800);

    // 24 lines × ~10 frames ≈ 240 would mean the memo boundary is broken.
    const lineCommits = renderCountSince(mark, 'TerminalLine');
    expect(lineCommits, `TerminalLine commits: ${lineCommits}`).toBeLessThan(120);
  },
};

/**
 * Switching tabs re-renders the pane grid but unrelated chrome at most once,
 * and switching back does not double the cost.
 */
export const TabSwitchCommitBudget: Story = {
  tags: ['nightly'],
  args: {
    fixture: asFixture(oneTabThenTwo),
    start: 'one-tab',
    transitions: [
      { match: /^new-window\b/, to: 'two-tabs' },
      { match: /^select-window -t @0$/, to: 'first-active' },
    ],
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
    expect(tabsCommits, `WindowTabs commits: ${tabsCommits}`).toBeLessThanOrEqual(6);
    expect(sidebarCommits, 'Sidebar (closed) must not render').toBe(0);
  },
};

/**
 * With no output and no typing, terminal redraws stay at ~0. Guards against
 * the regression fixed in d4523d0 (a glyph the canvas cannot measure redrew
 * every terminal forever).
 */
export const IdleRedrawBudget: Story = {
  tags: ['nightly'],
  args: { fixture: asFixture(lsListing), start: 'listed', transitions: enterShows('symbols') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });
    expect(renderCountSince(0, 'TerminalLine')).toBeGreaterThan(0);
    await user.click(canvas.getAllByRole('group', { name: /^Pane /i })[0]);
    await waitForQuiescence();

    // The symbols that triggered d4523d0.
    await user.keyboard('echo "● ⎿ ┌─┐"{Enter}');
    await wait(800);
    await waitForQuiescence();

    const mark = renderLogMark();
    await wait(1500);

    const paneCommits = renderCountSince(mark, 'Pane:');
    const terminalCommits = renderCountSince(mark, 'TerminalLine');
    // The empty prefix matches every id: an unbudgeted redraw is the one sought.
    const totalCommits = renderCountSince(mark, '');

    expect(
      terminalCommits,
      `TerminalLine commits during idle must be 0: ${terminalCommits} (${JSON.stringify(renderCountsById(mark))})`,
    ).toBe(0);
    expect(paneCommits, `Pane commits during idle must be 0: ${paneCommits}`).toBe(0);
    expect(totalCommits, `Total component commits during idle must be 0: ${totalCommits}`).toBe(0);
  },
};
