import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor, fireEvent } from 'storybook/test';
import { WindowTabs } from './WindowTabs';
import { ProviderHarness } from '../stories/StoryHarness';

const meta: Meta<typeof WindowTabs> = {
  title: 'Components/WindowTabs',
  component: WindowTabs,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof WindowTabs>;

export const Single: Story = {
  render: () => (
    <ProviderHarness height={60}>
      <WindowTabs />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await waitFor(
      () => {
        const list = canvas.getAllByRole('tab');
        expect(list.length).toBeGreaterThanOrEqual(1);
        return list;
      },
      { timeout: 5000 },
    );
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');

    // A lone tab reads as a label on the window, so it sits where every other
    // tab sits — hard against the left of the strip — rather than drifting to
    // the far edge away from the sidebar toggle it follows.
    const strip = canvasElement.querySelector('.tab-list') as HTMLElement;
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tabs[0].getBoundingClientRect();
    expect(tabBox.left - stripBox.left).toBeLessThan(stripBox.width / 4);

    // ...and it takes no hover background: there is nothing to switch to, and
    // on the desktop this tab is the window's drag handle.
    await userEvent.hover(tabs[0]);
    await waitFor(() => {
      expect(getComputedStyle(tabs[0]).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    });
  },
};

export const Multiple: Story = {
  render: () => (
    <ProviderHarness
      height={60}
      initCommands={[
        'rename-window welcome',
        'new-window',
        'rename-window features',
        'new-window',
        'rename-window dashboard',
        'select-window -t @1',
      ]}
    >
      <WindowTabs />
    </ProviderHarness>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Three tabs with the middle one active. Click a tab to switch.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await waitFor(
      () => {
        const list = canvas.getAllByRole('tab');
        expect(list.length).toBeGreaterThanOrEqual(3);
        return list;
      },
      { timeout: 5000 },
    );

    // The "features" tab should start active.
    const featuresTab = tabs.find((t) => /features/i.test(t.textContent ?? ''));
    expect(featuresTab).toBeDefined();
    expect(featuresTab).toHaveAttribute('aria-selected', 'true');

    // Clicking the "dashboard" tab flips active state via optimistic update.
    const dashboardTab = tabs.find((t) => /dashboard/i.test(t.textContent ?? ''));
    expect(dashboardTab).toBeDefined();
    await userEvent.click(dashboardTab!);
    await waitFor(
      () => {
        const refreshed = canvas.getAllByRole('tab');
        const refreshedDashboard = refreshed.find((t) => /dashboard/i.test(t.textContent ?? ''));
        expect(refreshedDashboard).toHaveAttribute('aria-selected', 'true');
      },
      { timeout: 3000 },
    );
  },
};

/**
 * Renaming a tab in place, then pasting: the clipboard belongs to the field.
 * The keyboard actor's window-level paste listener used to take it for the
 * pane — the rename field stayed empty and the shell got the text.
 */
export const RenameWithPaste: Story = {
  render: () => (
    <ProviderHarness
      height={60}
      initCommands={['rename-window welcome', 'new-window', 'rename-window features']}
    >
      <WindowTabs />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const features = await waitFor(
      () => {
        const tab = canvas.getAllByRole('tab').find((t) => /features/i.test(t.textContent ?? ''));
        expect(tab).toBeDefined();
        return tab!;
      },
      { timeout: 5000 },
    );

    // Right-click → Rename Tab opens the field with the name selected.
    await userEvent.pointer({ keys: '[MouseRight]', target: features });
    const rename = await waitFor(
      () => within(document.body).getByRole('menuitem', { name: /rename tab/i }),
      { timeout: 3000 },
    );
    await userEvent.click(rename);
    const field = await waitFor(() => canvas.getByTestId('inline-rename') as HTMLInputElement, {
      timeout: 3000,
    });
    expect(document.activeElement).toBe(field);

    // A paste into the field is the browser's to insert: nothing stops it,
    // and the field keeps the focus.
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: () => 'pasted name' },
    });
    field.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(field);

    // Escape puts the tab back as it was.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(canvas.queryByTestId('inline-rename')).toBeNull();
    });
    expect(features).toHaveTextContent(/features/i);
  },
};

/**
 * Dragging a tab along the strip: past the threshold it lifts and rides with
 * the pointer, the tab it would precede shows the drop bar, and releasing it
 * is a reorder rather than a click — the active tab stays the active tab.
 */
export const Reorder: Story = {
  render: () => (
    <ProviderHarness
      height={60}
      initCommands={[
        'rename-window welcome',
        'new-window',
        'rename-window features',
        'new-window',
        'rename-window dashboard',
        'select-window -t @1',
      ]}
    >
      <WindowTabs />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await waitFor(
      () => {
        const list = canvas.getAllByRole('tab');
        expect(list.length).toBe(3);
        return list;
      },
      { timeout: 5000 },
    );
    const [welcome, features, dashboard] = tabs;
    expect(features).toHaveAttribute('aria-selected', 'true');

    const centre = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const from = centre(dashboard);
    const to = centre(welcome);
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0, isPrimary: true };
    fireEvent.pointerDown(dashboard, { ...pointer, clientX: from.x, clientY: from.y });
    // A nudge under the threshold is still a press.
    fireEvent.pointerMove(dashboard, { ...pointer, clientX: from.x - 2, clientY: from.y });
    expect(dashboard).not.toHaveClass('is-dragging');

    fireEvent.pointerMove(dashboard, { ...pointer, clientX: to.x - 10, clientY: to.y });
    await waitFor(() => {
      expect(dashboard).toHaveClass('is-dragging');
      expect(welcome).toHaveClass('is-drop-before');
    });
    // The lifted tab has moved left with the pointer.
    expect(centre(dashboard).x).toBeLessThan(from.x - 20);

    fireEvent.pointerUp(dashboard, { ...pointer, clientX: to.x - 10, clientY: to.y });
    // The browser follows a release with a click; after a drop it is swallowed.
    fireEvent.click(dashboard, { clientX: to.x - 10, clientY: to.y });
    await waitFor(() => {
      expect(canvasElement.querySelector('.is-dragging')).toBeNull();
      expect(canvasElement.querySelector('.is-drop-before')).toBeNull();
    });
    // A drop is not a click: the selection did not move to the dragged tab.
    expect(features).toHaveAttribute('aria-selected', 'true');
    expect(dashboard).toHaveAttribute('aria-selected', 'false');

    // The next plain click selects as ever.
    await userEvent.click(dashboard);
    await waitFor(() => {
      expect(dashboard).toHaveAttribute('aria-selected', 'true');
    });
  },
};
