/**
 * Tab actions from the keyboard and the tab strip's context menu, over states
 * recorded from real tmux (`fixtures/scenarios/tab-actions.ts`):
 *
 *  - TabNextPrev         the next/previous-window keys move between the tabs, wrapping
 *  - TabContextMenuOps   the strip's context menu makes a tab, and closes it again
 *  - TabKillOptimistic   closing the current tab drops it before tmux has answered
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture, type FixtureAdapter } from './fixtures/FixtureAdapter';
import tabActions from './fixtures/gen/tab-actions.json';
import { activePaneId, activeWindow, paneGroups, windowTabEls, windows } from './appStoryHelpers';
import type { Canvas } from './appStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Scenarios/Tab Actions',
  component: FixtureApp,
  args: { fixture: asFixture(tabActions), start: 'one-tab' },
  render: (args) => <FixtureApp {...args} onAdapterReady={keepAdapter} />,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/** The adapter of the story on screen, to name what the app sent when a step fails. */
let adapter: FixtureAdapter | null = null;
function keepAdapter(a: FixtureAdapter) {
  adapter = a;
}
const sent = () => `sent: ${JSON.stringify(adapter?.commands ?? [])}`;

/** The recorded tabs are in the strip, and a pane of the current one is focused. */
async function waitForTabs(canvas: Canvas, count: number) {
  await waitFor(
    () => {
      expect(windowTabEls(canvas).length).toBe(count);
      expect(paneGroups(canvas).length).toBeGreaterThan(0);
    },
    { timeout: 10000 },
  );
  const pane = paneGroups(canvas)[0];
  await userEvent.click(pane);
  await waitFor(() => expect(activePaneId()).toBe(pane.getAttribute('data-pane-id')), {
    timeout: 10000,
  });
}

/**
 * The tmuxy config binds C-Tab to `next-window` and C-S-Tab to
 * `previous-window`. With the second of two tabs current, the next one is
 * the first (tmux wraps), and the previous one from there is the second.
 */
export const TabNextPrev: Story = {
  args: {
    start: 'second-active',
    transitions: [
      { match: /^next-window$/, to: 'first-active' },
      { match: /^previous-window$/, to: 'second-active' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForTabs(canvas, 2);
    expect(activeWindow()?.id).toBe('@2');
    await user.keyboard('{Control>}{Tab}{/Control}');
    await waitFor(() => expect(activeWindow()?.id, sent()).toBe('@0'), { timeout: 10000 });
    await user.keyboard('{Control>}{Shift>}{Tab}{/Shift}{/Control}');
    await waitFor(() => expect(activeWindow()?.id, sent()).toBe('@2'), { timeout: 10000 });
  },
};

/** Right-click a tab in the middle, opening its context menu. */
function contextMenu(tab: HTMLElement) {
  const r = tab.getBoundingClientRect();
  tab.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }),
  );
}

/**
 * Right-click a tab → "New Tab" makes a window and it shows in the strip;
 * right-click the new tab → "Close Tab" kills that window by id, and the
 * strip is back to one tab with a real pane focused.
 */
export const TabContextMenuOps: Story = {
  args: {
    transitions: [
      { match: /^new-window$/, to: 'two-tabs' },
      { match: /^kill-window -t @1$/, to: 'closed' },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForTabs(canvas, 1);

    contextMenu(windowTabEls(canvas)[0]);
    await user.click(await canvas.findByText('New Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(windowTabEls(canvas).length, sent()).toBe(2);
        expect(activeWindow()?.id).toBe('@1');
      },
      { timeout: 10000 },
    );

    const tabs = windowTabEls(canvas);
    contextMenu(tabs[tabs.length - 1]);
    await user.click(await canvas.findByText('Close Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(windowTabEls(canvas).length, sent()).toBe(1);
        expect(windows().some((w) => w.id === '@1')).toBe(false);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 10000 },
    );
  },
};

/** How long tmux takes to answer the kill: longer than the drop may take. */
const KILL_ANSWER_MS = 1500;

/**
 * "Close Tab" on the current tab: the strip drops it within 1.2s — while
 * tmux, slowed to {@link KILL_ANSWER_MS}, has not answered yet — the other
 * tab becomes current, and the answer never brings the killed tab back.
 *
 * The menu is the path that kills at once: tmuxy's config binds C-a `&` to
 * `confirm-before … kill-window`, which asks tmux for a y/n first.
 */
export const TabKillOptimistic: Story = {
  args: {
    start: 'two-tabs',
    commandDelayMs: KILL_ANSWER_MS,
    transitions: [{ match: /^kill-window -t @1$/, to: 'closed' }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await waitForTabs(canvas, 2);
    expect(activeWindow()?.id).toBe('@1');

    const tabs = windowTabEls(canvas);
    contextMenu(tabs[tabs.length - 1]);
    const closeTab = await canvas.findByText('Close Tab', undefined, { timeout: 5000 });
    const pressed = performance.now();
    await user.click(closeTab);
    await waitFor(() => expect(windowTabEls(canvas).length, sent()).toBe(1), {
      timeout: 5000,
      interval: 50,
    });
    expect(performance.now() - pressed).toBeLessThan(1200);

    // Stays dropped through tmux's answer; the surviving tab is current.
    await new Promise((r) => setTimeout(r, KILL_ANSWER_MS + 500));
    expect(windowTabEls(canvas).length).toBe(1);
    expect(windows().every((w) => w.id !== '@1')).toBe(true);
    expect(activeWindow()?.id).toBe('@0');
    expect(activePaneId()).toMatch(/^%\d+$/);
  },
};
