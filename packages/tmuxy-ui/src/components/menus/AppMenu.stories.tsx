import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppMenu } from './AppMenu';
import { ProviderHarness } from '../../stories/StoryHarness';

const meta: Meta<typeof AppMenu> = {
  title: 'Components/AppMenu',
  component: AppMenu,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof AppMenu>;

export const OpenMenu: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <AppMenu />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));

    // All top-level submenus render.
    for (const label of ['Pane', 'Tab', 'Session', 'Theme', 'View', 'Debug', 'Help']) {
      expect(canvas.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
  },
};

export const TabSubmenuKeybindings: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <AppMenu />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Tab' }));

    // Keybinding labels come from the adapter's get_key_bindings snapshot
    // (prefix C-a, `c` = new-window), not from hardcoded strings.
    const newTab = await waitFor(() => canvas.getByRole('menuitem', { name: /new tab/i }));
    const keyLabel = newTab.querySelector('.menu-keybinding');
    expect(keyLabel).not.toBeNull();
    expect(keyLabel!.textContent).toBe('ctrl+a c');

    // With a single window, tab navigation is disabled.
    expect(canvas.getByRole('menuitem', { name: /next tab/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

export const ThemeSubmenu: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <AppMenu />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Theme' }));

    // Mode toggles always render; the active mode carries the filled marker.
    const dark = await waitFor(() => canvas.getByRole('menuitem', { name: /dark mode/i }));
    expect(canvas.getByRole('menuitem', { name: /light mode/i })).toBeInTheDocument();
    expect(
      `${dark.textContent}${canvas.getByRole('menuitem', { name: /light mode/i }).textContent}`,
    ).toContain('●');
  },
};

/**
 * Debug submenu — the local action trace and nothing else (docs/TELEMETRY.md).
 *
 * The switch is the gate: with tracing off there is no level to pick and no
 * file worth opening, so every item below it is disabled. Flipping it on has
 * to unlock them, which is the interaction this covers — a menu that renders
 * the right items but never re-enables them looks identical in a static check.
 */
export const DebugTraceControls: Story = {
  render: () => (
    <ProviderHarness height={400}>
      <AppMenu />
    </ProviderHarness>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Debug' }));

    const toggle = await waitFor(() =>
      canvas.getByRole('menuitemcheckbox', { name: /enable traces/i }),
    );
    // Off by default — a normal install records nothing.
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    const levels = ['Shape', 'Labeled', 'Full'] as const;
    const levelItem = (name: string) => canvas.getByRole('menuitemradio', { name });
    const copyPath = () => canvas.getByRole('menuitem', { name: /copy trace.ndjson path/i });

    // Everything the switch gates starts disabled.
    for (const name of levels) {
      expect(levelItem(name)).toHaveAttribute('aria-disabled', 'true');
    }
    expect(copyPath()).toHaveAttribute('aria-disabled', 'true');

    // Turn it on: the menu closes on click, so reopen to read the new state.
    await userEvent.click(toggle);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Debug' }));

    await waitFor(() =>
      expect(canvas.getByRole('menuitemcheckbox', { name: /enable traces/i })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    // react-menu omits aria-disabled entirely when an item is enabled.
    for (const name of levels) {
      expect(levelItem(name)).not.toHaveAttribute('aria-disabled', 'true');
    }
    expect(copyPath()).not.toHaveAttribute('aria-disabled', 'true');
    // Shape is the safe default the backend reports back.
    expect(levelItem('Shape')).toHaveAttribute('aria-checked', 'true');
    expect(levelItem('Full')).toHaveAttribute('aria-checked', 'false');

    // Picking a level is exclusive — the previous one clears.
    await userEvent.click(levelItem('Full'));
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(canvas.getByRole('menuitem', { name: 'Debug' }));
    await waitFor(() => expect(levelItem('Full')).toHaveAttribute('aria-checked', 'true'));
    expect(levelItem('Shape')).toHaveAttribute('aria-checked', 'false');
  },
};
