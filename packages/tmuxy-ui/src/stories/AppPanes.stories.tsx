import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { V86AppHarness } from './StoryHarness';
import { withTmuxView } from './tmuxView';
import {
  pasteLine,
  activePaneId,
  paneGroups,
  focusFirstPane,
  windows,
  paneRect,
  paneIds,
  findMenuItem,
  settleGeometry,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Panes',
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
 * Real keybindings — Ctrl+hjkl pane navigation: the keyboardActor intercepts the
 * Ctrl+h/j/k/l root bindings client-side and issues directional `select-pane`
 * commands to real tmux (so C-h moves the active pane left, NOT a literal
 * backspace into the shell). Drives real Ctrl-key presses and asserts the active
 * pane moves.
 */
export const PaneNavKeys: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, userEvent.setup());
    // Start on the right pane, then Ctrl+h must move the active pane left.
    const right = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') !== activePaneId(),
    );
    const rightId = right?.getAttribute('data-pane-id');
    await user.click(right ?? paneGroups(canvas)[0]);
    await waitFor(() => expect(activePaneId()).toBe(rightId), { timeout: 15000, interval: 200 });
    await user.keyboard('{Control>}h{/Control}');
    await waitFor(() => expect(activePaneId()).not.toBe(rightId), {
      timeout: 15000,
      interval: 300,
    });
    const leftId = activePaneId();
    // Ctrl+l moves back to the right.
    await user.keyboard('{Control>}l{/Control}');
    await waitFor(() => expect(activePaneId()).not.toBe(leftId), { timeout: 15000, interval: 300 });
  },
};

/**
 * Horizontal split: C-a `|` runs the mapped `split-window -h` through real tmux.
 * The two children of the split must share a row — same top, different left —
 * per the geometry tmux reports in `%layout-change` (we assert rendered rects,
 * not client-computed values).
 */
export const KeyboardSplitHorizontal: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const target = activePaneId();
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('|');
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThanOrEqual(3);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
    // The split pane and the new pane share a row: same top, different left.
    const a = paneRect(canvas, target);
    const b = paneRect(canvas, activePaneId());
    expect(Math.abs(a.top - b.top)).toBeLessThan(4);
    expect(a.left).not.toBe(b.left);
  },
};

/**
 * Kill pane via keyboard: C-a `x` kills the active pane in real tmux. Asserts the
 * doomed pane id is GONE (negative guard — "count changed" alone could pass on an
 * unrelated pane appearing) and focus lands on a surviving real pane.
 */
export const KillPane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doomed = activePaneId();
    expect(doomed).toMatch(/^%\d+$/);
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('x');
    await waitFor(
      () => {
        expect(paneIds(canvas)).not.toContain(doomed);
        expect(activePaneId()).toMatch(/^%\d+$/);
        expect(activePaneId()).not.toBe(doomed);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Kill pane via the header ✕ button — pure mouse path through PaneHeader's
 * group-aware CLOSE_PANE (not raw kill-pane). The clicked pane's id must vanish.
 */
export const KillPaneViaHeaderButton: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doomed = paneIds(canvas)[0];
    const paneEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === doomed,
    )!;
    const closeBtn = paneEl.querySelector('[aria-label="Close pane"]') as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    await user.click(closeBtn!);
    await waitFor(() => expect(paneIds(canvas)).not.toContain(doomed), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Zoom: C-a `z` (resize-pane -Z). The active pane's rendered width must expand to
 * ~the full container (tmux reports the zoomed layout via %layout-change); C-a `z`
 * again restores the original width. Both directions asserted — a stuck zoom or a
 * no-op both fail.
 */
export const ZoomPane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await settleGeometry(canvas);
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('z');
    await waitFor(() => expect(paneRect(canvas, id).width).toBeGreaterThan(before * 1.5), {
      timeout: 30000,
      interval: 500,
    });
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('z');
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeLessThan(20), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Zoom via header double-click: double-clicking a pane's header dispatches
 * ZOOM_PANE → the same real `resize-pane -Z` round-trip as `C-a z`, driven
 * purely by mouse. Both directions of the toggle asserted via layout rects.
 */
export const ZoomViaHeaderDoubleClick: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await settleGeometry(canvas);
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    const header = () =>
      paneGroups(canvas)
        .find((p: HTMLElement) => p.getAttribute('data-pane-id') === id)!
        .querySelector('.pane-header') as HTMLElement;
    await user.dblClick(header());
    await waitFor(() => expect(paneRect(canvas, id).width).toBeGreaterThan(before * 1.5), {
      timeout: 30000,
      interval: 500,
    });
    await user.dblClick(header());
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeLessThan(20), {
      timeout: 30000,
      interval: 500,
    });
  },
};

/**
 * Swap: C-a `>` (swap-pane -D) exchanges the two panes' positions. We record which
 * id is leftmost before, and assert the OTHER id is leftmost after — position data
 * comes from the real re-reported layout.
 */
export const SwapPanes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const leftBefore = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('>');
    await waitFor(
      () => {
        const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
        expect(leftNow).not.toBe(leftBefore);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Drag a pane onto another to swap them: mousedown on the source header, move
 * past the drag threshold onto the target pane, release. The drag machine
 * issues a real `swap-pane -d -s <src> -t <target>` on drop, and the two panes
 * must exchange positions in the re-reported layout — the same assert as the
 * keyboard SwapPanes, driven purely by mouse drag-and-drop.
 */
export const PaneDragSwap: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const [a, b] = paneIds(canvas);
    const src = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
    const dst = src === a ? b : a;
    const header = paneGroups(canvas)
      .find((p: HTMLElement) => p.getAttribute('data-pane-id') === src)!
      .querySelector('.pane-header') as HTMLElement;
    const hRect = header.getBoundingClientRect();
    const dstRect = paneRect(canvas, dst);
    const startX = hRect.left + hRect.width / 2;
    const startY = hRect.top + hRect.height / 2;
    const endX = dstRect.left + dstRect.width / 2;
    const endY = dstRect.top + dstRect.height / 2;
    header.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, clientX: startX, clientY: startY, bubbles: true }),
    );
    // Walk the pointer to the target: the first steps cross the 5px threshold
    // (PaneHeader promotes the press to DRAG_START), later ones feed DRAG_MOVE
    // so the drag machine picks the drop target under the cursor. Events are
    // dispatched on elements (bubbling to the document/window listeners) so
    // handlers that inspect `event.target` see a real element.
    const dstEl = paneGroups(canvas).find(
      (p: HTMLElement) => p.getAttribute('data-pane-id') === dst,
    )!;
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      const x = startX + ((endX - startX) * i) / steps;
      const y = startY + ((endY - startY) * i) / steps;
      (i <= 2 ? header : dstEl).dispatchEvent(
        new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 120));
    }
    dstEl.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));
    await waitFor(
      () => {
        const leftNow = paneRect(canvas, a).left < paneRect(canvas, b).left ? a : b;
        expect(leftNow).not.toBe(src);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Keyboard resize: C-a `H` (resize-pane -L 5). The active pane's rendered width
 * must change by roughly 5 columns and STICK (re-checked after settling) — the new
 * geometry comes from tmux's %layout-change, not a client-side prediction.
 */
export const ResizePaneKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    await settleGeometry(canvas);
    const id = activePaneId();
    const before = paneRect(canvas, id).width;
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('{Shift>}H{/Shift}');
    await waitFor(() => expect(Math.abs(paneRect(canvas, id).width - before)).toBeGreaterThan(20), {
      timeout: 30000,
      interval: 500,
    });
    // The resize must persist (a transient optimistic wiggle that snaps back
    // fails). Let the trailing layout confirms settle first — H is a repeat
    // binding whose confirms can land a beat after the rect first moves.
    await settleGeometry(canvas);
    const resized = paneRect(canvas, id).width;
    await new Promise((r) => setTimeout(r, 1500));
    expect(Math.abs(paneRect(canvas, id).width - resized)).toBeLessThan(10);
  },
};

/**
 * Break pane: `tmuxy pane break` (guest CLI, run in real bash) moves the pane into
 * its own window. A second window tab must appear, backed by a real `@N` id.
 */
export const BreakPane: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await focusFirstPane(canvas, userEvent.setup());
    const tabsBefore = windows().filter((w) => w.windowType === 'tab').length;
    pasteLine('tmuxy pane break');
    await waitFor(
      () =>
        expect(windows().filter((w) => w.windowType === 'tab').length).toBeGreaterThan(tabsBefore),
      { timeout: 30000, interval: 500 },
    );
    // The tab bar renders the new window as a real tab.
    await waitFor(() => expect(canvas.getAllByRole('tab').length).toBeGreaterThan(tabsBefore), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * Pane context menu: right-click a pane's header tab → the context menu opens;
 * clicking "Split Pane Below" runs the real split. Drives the actual menu item,
 * not the underlying event, and asserts a real new pane id.
 */
export const PaneContextMenuSplit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const before = paneGroups(canvas).length;
    const headerTab = canvasElement.querySelector('.pane-tab') as HTMLElement | null;
    expect(headerTab).not.toBeNull();
    const hr = headerTab!.getBoundingClientRect();
    headerTab!.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: hr.left + 5,
        clientY: hr.top + 5,
      }),
    );
    const doc = canvasElement.ownerDocument;
    await user.click(await findMenuItem(doc, /Split Pane Below/i));
    await waitFor(
      () => {
        expect(paneGroups(canvas).length).toBeGreaterThan(before);
        expect(activePaneId()).toMatch(/^%\d+$/);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Special keys: Ctrl+C must reach the guest process as SIGINT. We start a
 * `sleep 100`, interrupt it, and run another command — the second command's output
 * can only render if the interrupt actually killed the sleep.
 */
export const SendSpecialKeys: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    pasteLine('sleep 100');
    await new Promise((r) => setTimeout(r, 1500));
    await user.keyboard('{Control>}c{/Control}');
    await new Promise((r) => setTimeout(r, 800));
    pasteLine('echo AFTER_INT_77');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /AFTER_INT_77/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};

/**
 * Sync panes: `synchronize-panes` in real tmux — typed input then mirrors into
 * every pane of the window. Set through the CLI (no key is bound to it), and
 * by value rather than toggled: the command that turns it off is itself
 * mirrored into every pane, and a toggle run twice would leave it on. We paste
 * a sentinel with sync ON (must render in BOTH panes) and another after
 * turning it OFF (must render in exactly one) — the negative half guards
 * against a stuck setting.
 */
export const SyncPanes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const inPanes = (re: RegExp) =>
      paneGroups(canvas).filter((p: HTMLElement) => re.test(p.textContent ?? '')).length;
    // Set, then wait for the echo chained after it: it prints only once tmux
    // has applied the setting, and the typed line carries the marker too, so
    // the output is its second occurrence. A sentinel typed before the setting
    // lands would reach one pane and read as sync not working.
    const set = async (value: 'on' | 'off', marker: string) => {
      pasteLine(`tmuxy run setw synchronize-panes ${value} && echo ${marker}`);
      await waitFor(
        () =>
          expect(
            paneGroups(canvas).some(
              (p: HTMLElement) => (p.textContent ?? '').split(marker).length - 1 >= 2,
            ),
          ).toBe(true),
        { timeout: 30000, interval: 500 },
      );
    };
    await set('on', 'SYNC_SET_42');
    pasteLine('echo SYNC_ON_42');
    await waitFor(() => expect(inPanes(/SYNC_ON_42/)).toBe(2), { timeout: 30000, interval: 500 });
    await set('off', 'SYNC_UNSET_42');
    pasteLine('echo SYNC_OFF_42');
    await waitFor(() => expect(inPanes(/SYNC_OFF_42/)).toBe(1), { timeout: 30000, interval: 500 });
    // Give the mirror a beat, then confirm it STAYED in one pane (not just raced).
    await new Promise((r) => setTimeout(r, 1500));
    expect(inPanes(/SYNC_OFF_42/)).toBe(1);
  },
};
