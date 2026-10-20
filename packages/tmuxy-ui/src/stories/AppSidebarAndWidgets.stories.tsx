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
  paneIds,
} from './appStoryHelpers';

const meta: Meta<typeof V86AppHarness> = {
  title: 'Scenarios/Application Sidebar & Widgets',
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
 * Sidebar tree (real tmux via v86). The sidebar is a native React tab/pane tree
 * derived from the live session state, with no sidebar window.
 * The drawer opens, lists every tab and its panes, clicking a pane activates it
 * (real `select-pane` round-trip), and toggling again hides the drawer.
 */
export const SidebarToggle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    const first = activePaneId();
    const second = paneIds(canvas).find((p) => p !== first)!;

    const toggle = canvasElement.querySelector('.sidebar-toggle-left') as HTMLElement;
    expect(toggle).not.toBeNull();
    await user.click(toggle);

    // The column opens onto a real tmux pane running the tree widget, so the
    // tree is what that pane renders — not a headless React panel.
    const tree = await waitFor(
      () => {
        const el = doc.querySelector('.sidebar-tree') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 30000, interval: 500 },
    );
    expect(windows().some((w) => w.windowType === 'sidebar-left')).toBe(true);
    // Both panes of the current tab appear as tree nodes.
    await waitFor(
      () => {
        expect(tree.querySelector(`[data-testid="tree-pane-${first}"]`)).not.toBeNull();
        expect(tree.querySelector(`[data-testid="tree-pane-${second}"]`)).not.toBeNull();
      },
      { timeout: 15000, interval: 400 },
    );

    // Clicking the OTHER pane's node activates it (real select-pane round-trip).
    await user.click(tree.querySelector(`[data-testid="tree-pane-${second}"]`) as HTMLElement);
    await waitFor(() => expect(activePaneId()).toBe(second), { timeout: 20000, interval: 500 });

    // Toggle off → the drawer hides.
    await user.click(toggle);
    await waitFor(() => expect(doc.querySelector('.sidebar-tree')).toBeNull(), {
      timeout: 15000,
      interval: 500,
    });
  },
};

/**
 * Sidebar drag-a-pane-between-tabs (real tmux via v86). With two tabs, dragging
 * a pane node from the active tab onto another tab's node issues a real
 * `join-pane`, moving the pane into that tab — verified by the pane's reported
 * window id changing after the drop.
 */
export const SidebarDragPaneToTab: Story = {
  args: { initCommands: ['split-window -h', 'new-window'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    const snap = () =>
      (
        window as unknown as {
          app: {
            getSnapshot(): {
              context: {
                activeWindowId: string | null;
                windows: Array<{ id: string; windowType: string | null }>;
                panes: Array<{ tmuxId: string; windowId: string }>;
              };
            };
          };
        }
      ).app.getSnapshot().context;

    const toggle = canvasElement.querySelector('.sidebar-toggle-left') as HTMLElement;
    await user.click(toggle);
    const tree = await waitFor(
      () => {
        const el = doc.querySelector('.sidebar-tree') as HTMLElement | null;
        expect(el).not.toBeNull();
        return el!;
      },
      { timeout: 30000, interval: 500 },
    );

    // Derive the drag source/target from the RENDERED tree (a window with an
    // empty name is filtered out of the visible tabs, so only trust nodes that
    // actually exist).
    const { paneEl, dstTabEl, paneId, dstWindowId } = await waitFor(
      () => {
        const tabNodes = [...tree.querySelectorAll('[data-testid^="tree-tab-"]')] as HTMLElement[];
        const paneNodes = [
          ...tree.querySelectorAll('[data-testid^="tree-pane-"]'),
        ] as HTMLElement[];
        expect(tabNodes.length).toBeGreaterThanOrEqual(2);
        expect(paneNodes.length).toBeGreaterThanOrEqual(1);
        const pEl = paneNodes[0];
        const pid = pEl.getAttribute('data-pane-id')!;
        const srcWin = snap().panes.find((p) => p.tmuxId === pid)!.windowId;
        const dTab = tabNodes.find((t) => t.getAttribute('data-window-id') !== srcWin);
        expect(dTab).toBeTruthy();
        return {
          paneEl: pEl,
          dstTabEl: dTab!,
          paneId: pid,
          dstWindowId: dTab!.getAttribute('data-window-id')!,
        };
      },
      { timeout: 20000, interval: 500 },
    );
    const dt = new DataTransfer();
    paneEl.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    dstTabEl.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    dstTabEl.dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    paneEl.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));

    // The pane now reports the destination tab's window (real join-pane landed).
    await waitFor(
      () => {
        const moved = snap().panes.find((p) => p.tmuxId === paneId);
        expect(moved?.windowId).toBe(dstWindowId);
      },
      { timeout: 30000, interval: 500 },
    );
  },
};

// ───────────────────────── §6 Widgets ─────────────────────────

/**
 * Widget exit: a pane running a widget prints a `__TMUXY_WIDGET__:<name>`
 * marker and the UI swaps the terminal renderer for the widget component; Ctrl+C
 * in it kills the widget process (SIGINT through the real WidgetPane
 * capture-phase handler → send-keys C-c), the terminal returns, and the shell is
 * usable again.
 *
 * Driven through `tmuxy-widget` directly: the marker protocol is what the UI
 * actually contracts on.
 */
export const WidgetExitRestoresShell: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const user = userEvent.setup();
    await focusFirstPane(canvas, user);
    const doc = canvasElement.ownerDocument;
    const widgetPane = () => doc.querySelector('.pane-wrapper[aria-label^="Widget pane"]');
    pasteLine(`{ sleep 3600; } | $HOME/.config/tmuxy/bin/tmuxy/tmuxy-widget tree`);
    await waitFor(
      () => {
        const pane = widgetPane();
        expect(pane).not.toBeNull();
        // Visible, not merely mounted.
        expect(pane!.getBoundingClientRect().height).toBeGreaterThan(50);
      },
      { timeout: 40000, interval: 500 },
    );
    await user.keyboard('{Control>}c{/Control}');
    await waitFor(() => expect(widgetPane()).toBeNull(), {
      timeout: 20000,
      interval: 500,
    });
    pasteLine('echo AFTER_WIDGET_5');
    await waitFor(
      () =>
        expect(
          paneGroups(canvas).some((p: HTMLElement) => /AFTER_WIDGET_5/.test(p.textContent ?? '')),
        ).toBe(true),
      { timeout: 30000, interval: 500 },
    );
  },
};
