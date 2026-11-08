import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, userEvent, waitFor } from 'storybook/test';
import { AppMenu } from './AppMenu';
import { FixtureProvider } from '../../stories/FixtureHarness';
import { asFixture } from '../../stories/fixtures/FixtureAdapter';
import panes from '../../stories/fixtures/gen/panes.json';

const PANES = asFixture(panes);

const meta: Meta<typeof AppMenu> = {
  title: 'Components/AppMenu',
  component: AppMenu,
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj<typeof AppMenu>;

/**
 * Kill Session is one click from ending every pane: the item asks first, and
 * Cancel leaves the session alone.
 */
export const KillSessionAsksFirst: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <AppMenu />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(page.getByRole('menuitem', { name: 'Session' }));
    const kill = await waitFor(() => page.getByRole('menuitem', { name: /kill session/i }));
    await userEvent.click(kill);

    const dialog = await waitFor(() => page.getByText(/kill session .*\?/i));
    expect(dialog).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: /cancel/i }));
    await waitFor(() => {
      expect(page.queryByText(/kill session .*\?/i)).toBeNull();
    });
  },
};

export const TabSubmenuKeybindings: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <AppMenu />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    // The menu is portalled out of the story, so its items are queried on the document.
    const canvas = within(canvasElement);
    const menu = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));

    for (const label of ['Pane', 'Tab', 'Session', 'View', 'Debug']) {
      expect(menu.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    await userEvent.click(menu.getByRole('menuitem', { name: 'Tab' }));

    // Key labels come from the bindings tmux reported on connect: the recorded
    // config binds `c` to `new-window -c "#{pane_current_path}"`, still New Tab.
    const newTab = await waitFor(() => menu.getByRole('menuitem', { name: /new tab/i }));
    const keyLabel = newTab.querySelector('.menu-keybinding');
    expect(keyLabel).not.toBeNull();
    expect(keyLabel!.textContent).toBe('ctrl+a c');

    expect(menu.getByRole('menuitem', { name: /next tab/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  },
};

export const ThemeSubmenu: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <AppMenu />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'View' }));
    await userEvent.click(await waitFor(() => menu.getByRole('menuitem', { name: 'Theme' })));

    const dark = await waitFor(() => menu.getByRole('menuitemcheckbox', { name: /dark mode/i }));
    const light = menu.getByRole('menuitemcheckbox', { name: /light mode/i });
    expect(menu.getByRole('menuitemcheckbox', { name: /system/i })).toBeInTheDocument();
    const checked = [dark, light].filter((el) => el.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);

    // The check is drawn, not only announced.
    const mark = (el: HTMLElement) => el.querySelector('.menu-item-lead [data-icon="check"]');
    const unchecked = checked[0] === dark ? light : dark;
    const box = mark(checked[0])?.getBoundingClientRect();
    expect(box?.width).toBeGreaterThan(0);
    expect(box?.height).toBeGreaterThan(0);
    expect(mark(unchecked)).toBeNull();
    const labelLeft = (el: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(el.lastChild ?? el);
      return range.getBoundingClientRect().left;
    };
    expect(labelLeft(unchecked)).toBeCloseTo(labelLeft(checked[0]), 0);
  },
};

/**
 * Debug submenu: with tracing off every item under the switch is disabled, and
 * turning it on re-enables them.
 */
export const DebugTraceControls: Story = {
  render: () => (
    <FixtureProvider height={400} fixture={PANES} start="one">
      <AppMenu />
    </FixtureProvider>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = within(document.body);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Debug' }));

    const toggle = await waitFor(() =>
      menu.getByRole('menuitemcheckbox', { name: /enable traces/i }),
    );
    // Off by default — a normal install records nothing.
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    const levels = ['Shape', 'Labeled', 'Full'] as const;
    const levelItem = (name: string) => menu.getByRole('menuitemradio', { name });
    const copyPath = () => menu.getByRole('menuitem', { name: /copy trace.ndjson path/i });

    for (const name of levels) {
      expect(levelItem(name)).toHaveAttribute('aria-disabled', 'true');
    }
    expect(copyPath()).toHaveAttribute('aria-disabled', 'true');

    // Turn it on: the menu closes on click, so reopen to read the new state.
    await userEvent.click(toggle);
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Debug' }));

    await waitFor(() =>
      expect(menu.getByRole('menuitemcheckbox', { name: /enable traces/i })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    for (const name of levels) {
      expect(levelItem(name)).not.toHaveAttribute('aria-disabled', 'true');
    }
    expect(copyPath()).not.toHaveAttribute('aria-disabled', 'true');
    // Shape is the safe default the backend reports back.
    expect(levelItem('Shape')).toHaveAttribute('aria-checked', 'true');
    expect(levelItem('Full')).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(levelItem('Full'));
    await userEvent.click(canvas.getByRole('button', { name: /menu/i }));
    await userEvent.click(menu.getByRole('menuitem', { name: 'Debug' }));
    await waitFor(() => expect(levelItem('Full')).toHaveAttribute('aria-checked', 'true'));
    expect(levelItem('Shape')).toHaveAttribute('aria-checked', 'false');
  },
};
