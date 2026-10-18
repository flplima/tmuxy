import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  paneIds,
  activeWindow,
  tabWindows,
  realTabWindows,
  windowTabEls,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Tabs',
  component: V86AppHarness,
  tags: ['v86'],
  args: { shared: true },
  decorators: [withTmuxView],
  parameters: {
    layout: 'fullscreen',
  },
};
export default meta;
type Story = StoryObj<typeof V86AppHarness>;

/**
 * New window via keyboard: C-a `c` (new-window) — real tmux creates a new `@N`
 * window, the tab bar renders it, and it becomes the active window with a real
 * focused pane.
 */
export const TabCreateKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const beforeIds = realTabWindows().map((w) => w.id);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('c');
    await waitFor(
      () => {
        const tabs = realTabWindows();
        expect(tabs.length).toBe(beforeIds.length + 1);
        const created = tabs.find((w) => !beforeIds.includes(w.id))!;
        expect(created.active).toBe(true);
        expect(activePaneId()).toMatch(/^%\d+$/);
        // Rendered in the tab bar too.
        expect(windowTabEls(canvas).length).toBe(tabs.length);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * New window via the tab bar `+` button — pure mouse path through WindowTabs'
 * handleNewWindow. Same round-trip assertions as the keyboard variant.
 */
export const TabCreateViaPlusButton: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realTabWindows().length;
    await user.click(canvas.getByLabelText('Create new tab'));
    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(before + 1);
        expect(activeWindow()?.id).toMatch(/^@\d+$/);
        expect(windowTabEls(canvas).length).toBe(before + 1);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Tab selection: with two windows, clicking a tab header selects that window
 * (mouse path), and Ctrl+digit selects by index (root-binding path). The active
 * window AND the rendered pane set must swap each time — asserting the pane swap
 * proves the full re-render, not just a highlight change.
 */
export const TabSelect: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    const panesOnW2 = paneIds(canvas).join(',');
    // Mouse: click the first WINDOW tab header (not a pane-header tab).
    await user.click(windowTabEls(canvas)[0]);
    await waitFor(
      () => {
        expect(activeWindow()?.index).toBe(1);
        expect(paneIds(canvas).join(',')).not.toBe(panesOnW2);
      },
      { timeout: 20000, interval: 500 },
    );
    // Keyboard: Ctrl+2 selects window index 2 again.
    await user.keyboard('{Control>}2{/Control}');
    await waitFor(
      () => {
        expect(activeWindow()?.index).toBe(2);
        expect(paneIds(canvas).join(',')).toBe(panesOnW2);
      },
      { timeout: 20000, interval: 500 },
    );
  },
};

/**
 * Tab cycling: S-Right (next-window) and S-Left (previous-window) root bindings.
 * With two windows each press flips the active window, including the wrap.
 */
export const TabNextPrev: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() => expect(activeWindow()?.index).toBe(1), { timeout: 20000, interval: 500 });
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 20000, interval: 500 });
  },
};

/**
 * Tab rename: `tmuxy tab rename` in guest bash → tmux emits %window-renamed → the
 * tab label updates. Asserting via the rendered tab (accessible name) proves the
 * name came back from real tmux, not local state.
 */
export const TabRename: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    pasteLine('tmuxy tab rename STORY_TAB9');
    await waitFor(() => expect(canvas.getByRole('tab', { name: /STORY_TAB9/ })).toBeTruthy(), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Kill window: create a second tab, then C-a `&` (kill-window) removes it — that
 * `@N` must be GONE (negative guard) and focus must land on the surviving tab.
 */
export const TabKill: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('tmuxy tab create');
    await waitFor(() => expect(tabWindows().length).toBe(2), { timeout: 30000, interval: 500 });
    await waitFor(() => expect(activeWindow()?.index).toBe(2), { timeout: 30000, interval: 500 });
    const doomed = activeWindow()!.id;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}&{/Shift}');
    await waitFor(
      () => {
        expect(tabWindows().map((w) => w.id)).not.toContain(doomed);
        expect(activeWindow()?.id).toMatch(/^@\d+$/);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Tab overflow: create several windows via the guest CLI; every tab renders in
 * the tab bar and the LAST one is still clickable (selects its window).
 */
export const WindowTabsOverflow: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('for i in 1 2 3 4 5; do tmuxy tab create >/dev/null; done; echo TABS_DONE_5');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /TABS_DONE_5/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 60000, interval: 700 },
    );
    await waitFor(() => expect(realTabWindows().length).toBe(6), { timeout: 30000, interval: 500 });
    expect(windowTabEls(canvas).length).toBe(6);
    // The last tab is reachable and clickable.
    const tabs = windowTabEls(canvas);
    await user.click(tabs[tabs.length - 1]);
    await waitFor(() => expect(activeWindow()?.index).toBe(6), { timeout: 20000, interval: 500 });
  },
};

// ─────────── §14 Interaction edge cases: prefix, IME, menus ───────────

/**
 * 3.2 — Tab context menu, pure mouse: right-click a tab → "New Tab" creates a
 * real window; right-click the new tab → "Close Tab" kills it. Covers the
 * WindowTabs context-menu paths (menu-driven new-window and the index-targeted
 * kill-window).
 */
export const TabContextMenuOps: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = realTabWindows().length;

    windowTabEls(canvas)[0].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 30 }),
    );
    await user.click(await canvas.findByText('New Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(before + 1);
        expect(windowTabEls(canvas).length).toBe(before + 1);
      },
      { timeout: 30000, interval: 500 },
    );

    // Close the newly-created tab via its context menu.
    const tabs = windowTabEls(canvas);
    tabs[tabs.length - 1].dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 30 }),
    );
    await user.click(await canvas.findByText('Close Tab', undefined, { timeout: 5000 }));
    await waitFor(
      () => {
        expect(realTabWindows().length).toBe(before);
        expect(windowTabEls(canvas).length).toBe(before);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * New-tab regression (two bugs, real tmux):
 *  1. Creating a tab must not flash a transient EXTRA tab. A `break-pane` tags
 *     the new window `@tmuxy-window-type=tab` a beat before its pane settles;
 *     the optimistic store must hide that tab-typed-but-paneless newborn (it
 *     stands the placeholder in for it) so the tab bar never shows a 3rd tab
 *     that blinks away. A MutationObserver over the tab list catches the blink.
 *  2. The new tab's pane must show its FIRST terminal row. New windows are born
 *     without `pane-border-status top` unless it's set globally, which would
 *     leave the pane at y=0 where the 24px PaneHeader steals row 0. The row must
 *     render fully below the header.
 */
export const NewTabNoBlinkFirstRowVisible: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const tabList = canvasElement.querySelector('.tab-list') as HTMLElement;
    const tabCount = () => tabList.querySelectorAll('.tab-name').length;
    const before = tabCount();

    // Bug 1: watch the tab bar for any transient tab beyond the one we create.
    let maxTabs = before;
    const obs = new MutationObserver(() => {
      maxTabs = Math.max(maxTabs, tabCount());
    });
    obs.observe(tabList, { childList: true, subtree: true, attributes: true });
    let running = true;
    const tick = () => {
      if (!running) return;
      maxTabs = Math.max(maxTabs, tabCount());
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    const add = await canvas.findByRole('button', { name: /create new tab/i }, { timeout: 8000 });
    await user.click(add);
    await waitFor(() => expect(tabCount()).toBe(before + 1), { timeout: 30000, interval: 100 });
    await sleep(2500); // settle
    running = false;
    obs.disconnect();

    // Bug 1: the tab bar never held more than the one new tab (no blink).
    expect(
      maxTabs,
      `tab bar flashed ${maxTabs} tabs (expected at most ${before + 1})`,
    ).toBeLessThanOrEqual(before + 1);
    expect(tabCount()).toBe(before + 1);

    // Bug 2: the new tab's pane shows its first terminal row, fully below the
    // header (not clipped behind it).
    const wrapper = canvasElement.querySelector(
      '.pane-layout-item.pane-active .pane-wrapper',
    ) as HTMLElement;
    const header = wrapper.querySelector('.pane-header') as HTMLElement;
    const firstLine = wrapper.querySelector('.pane-content .terminal-line') as HTMLElement;
    expect(header).not.toBeNull();
    expect(firstLine).not.toBeNull();
    const hb = header.getBoundingClientRect();
    const fb = firstLine.getBoundingClientRect();
    expect(
      fb.top,
      `first terminal row (top=${Math.round(fb.top)}) is hidden behind the header (bottom=${Math.round(hb.bottom)})`,
    ).toBeGreaterThanOrEqual(hb.bottom - 1);
  },
};
