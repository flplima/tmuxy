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
