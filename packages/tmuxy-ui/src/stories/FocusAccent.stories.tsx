/**
 * Which surface has the keyboard, said in colour (demo engine).
 *
 * The theme's accent (`--tab-active-text` — yellow on gruvbox) marks where you
 * are typing, and only one surface can wear it at a time. With the keyboard in
 * the panes it is the current tab's name. Move it to a sidebar and the accent
 * goes with it: the column's title takes it, and the tab drops back to plain
 * white, where it says only which tab is current.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Focus Accent',
  component: AppHarness,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'The accent follows the keyboard between the pane grid and the sidebar columns.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof AppHarness>;

const colourOf = (el: Element) => getComputedStyle(el).color;

export const TheAccentFollowsTheKeyboard: Story = {
  args: { height: 500, initCommands: ['rename-window main'] },
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'Opening the tree column and focusing it hands the accent to its title; the active tab turns white. Clicking back into a pane hands it back. Asserted on the painted colours, with the theme’s own tokens as the expected values — a rule that never applied would pass a class check.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: /^Pane /i }, { timeout: 8000 });

    const root = canvasElement.querySelector<HTMLElement>('.app-container')!;
    // Not every theme sets an accent apart from its white — gruvbox's is
    // yellow, the default's is the white itself — so the story gives itself a
    // distinguishable one. What is under test is which surface reads the
    // token, not what a particular theme puts in it.
    document.documentElement.style.setProperty('--tab-active-text', 'rgb(215, 153, 33)');
    const style = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    canvasElement.appendChild(probe);
    probe.style.color = style.getPropertyValue('--tab-active-text').trim();
    const accentPainted = colourOf(probe);
    probe.style.color = style.getPropertyValue('--term-white').trim();
    const whitePainted = colourOf(probe);
    probe.remove();
    expect(accentPainted).not.toBe(whitePainted);

    const activeTab = () => canvasElement.querySelector<HTMLElement>('.tab-name-active')!;
    // Keyboard in the panes: the current tab wears the accent.
    expect(root).not.toHaveClass('has-sidebar-focus');
    await waitFor(() => expect(colourOf(activeTab())).toBe(accentPainted));

    // Open the tree column and focus it.
    await userEvent.keyboard('{Control>}a{/Control}t');
    const title = await waitFor(
      () => {
        const el = canvasElement.querySelector<HTMLElement>('[data-testid="sidebar-title-left"]');
        expect(el, 'the tree column never opened').not.toBeNull();
        return el!;
      },
      { timeout: 8000 },
    );
    await userEvent.click(title);

    await waitFor(() => {
      expect(root).toHaveClass('has-sidebar-focus');
      // The column's title has it now...
      expect(colourOf(title)).toBe(accentPainted);
      // ...and the tab has given it up.
      expect(colourOf(activeTab())).toBe(whitePainted);
    });

    // Back to the panes the way the tree offers it — l / → leaves the column.
    await userEvent.keyboard('l');
    await waitFor(() => {
      expect(root).not.toHaveClass('has-sidebar-focus');
      expect(colourOf(activeTab())).toBe(accentPainted);
    });
    document.documentElement.style.removeProperty('--tab-active-text');
  },
};
