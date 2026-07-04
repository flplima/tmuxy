/**
 * Sidebar stories.
 *
 * The left sidebar is a hidden tmux window (windowType === 'sidebar') whose
 * single pane runs the `tmuxy tree` TUI, rendered as a left-docked drawer.
 * In the demo engine the real TUI can't run, so DemoTmux.createSidebar()
 * paints a static tree of the current tabs/panes — enough to exercise the
 * drawer's rendering, the toggle button, and the `prefix t` keybinding.
 *
 * The drawer portals into document.body via Modal — assertions query against
 * `document.body`, not `canvasElement`. Both open paths go through the real
 * user chain: TOGGLE_SIDEBAR → run-shell sidebar-create → a 'sidebar' window
 * → selectSidebarPaneId → <Sidebar> renders.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppHarness } from '../stories/StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Sidebar',
  component: AppHarness,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

/** Wait until the sidebar drawer portals into document.body. */
async function waitForSidebar(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector('.sidebar-drawer') as HTMLElement | null;
      if (!el) throw new Error('no .sidebar-drawer yet');
      return el;
    },
    { timeout: 8000 },
  );
}

/** Assert the drawer is visually present, left-pinned, and shows tree content. */
function expectSidebarVisible(overlay: HTMLElement): void {
  expect(overlay).toHaveClass('drawer-left');
  expect(overlay).toHaveClass('sidebar-drawer');

  // Drawer pins to the left edge.
  const container = overlay.querySelector('.modal-container') as HTMLElement | null;
  expect(container).not.toBeNull();
  expect(container!.style.left).toBe('0px');

  // Content area has real dimensions (catches overflow-clip / zero-height bugs).
  const content = overlay.querySelector('[data-testid="sidebar-content"]') as HTMLElement | null;
  expect(content).not.toBeNull();
  const rect = content!.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(50);
  expect(rect.height).toBeGreaterThan(50);

  // The tree reflects real panes — a "%N" pane row is painted.
  expect(content!.textContent ?? '').toMatch(/%\d+/);
}

// ---------------------------------------------------------------------------
// Open via the header toggle button (mouse user path)
// ---------------------------------------------------------------------------

export const OpenViaButton: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window main', 'new-window', 'rename-window logs', 'split-window -h'],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Clicking the header button opens the left drawer. Its tree lists every tab and the panes beneath it.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = await canvas.findByRole(
      'button',
      { name: /toggle sidebar/i },
      { timeout: 8000 },
    );
    await userEvent.click(toggle);

    const overlay = await waitForSidebar();
    expectSidebarVisible(overlay);

    // Button reflects the open state.
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // Tree shows both renamed tabs.
    const content = overlay.querySelector('[data-testid="sidebar-content"]') as HTMLElement;
    expect(content.textContent).toContain('main');
    expect(content.textContent).toContain('logs');

    // Clicking again closes the drawer (window stays alive, only hidden).
    await userEvent.click(toggle);
    await waitFor(() => expect(document.querySelector('.sidebar-drawer')).toBeNull(), {
      timeout: 5000,
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  },
};

// ---------------------------------------------------------------------------
// Open via the `prefix t` keybinding (keyboard user path)
// ---------------------------------------------------------------------------

export const OpenViaPrefixT: Story = {
  args: {
    height: 500,
    initCommands: ['rename-window editor'],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Pressing the tmux prefix (C-a) then `t` toggles the sidebar — handled client-side by the keyboard actor, never reaching tmux.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /Pane %0/i }, { timeout: 8000 });

    const user = userEvent.setup({ delay: 5 });
    // Prefix (C-a) then t.
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('t');

    const overlay = await waitForSidebar();
    expectSidebarVisible(overlay);

    // prefix t again closes it.
    await user.keyboard('{Control>}a{/Control}');
    await user.keyboard('t');
    await waitFor(() => expect(document.querySelector('.sidebar-drawer')).toBeNull(), {
      timeout: 5000,
    });
  },
};
