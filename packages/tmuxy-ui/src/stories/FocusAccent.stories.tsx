/**
 * Which surface has the keyboard, said in colour, over states recorded from
 * real tmux.
 *
 * The theme's accent (`--theme-accent` — yellow on gruvbox) marks where you
 * are typing. With the keyboard in the panes it is the active pane's outline.
 * Move it to a sidebar and the accent goes with it: the column's title takes
 * it. The current tab never wears it — it is the theme's white, and says only
 * which tab is current.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import tree from './fixtures/gen/tree.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Focus Accent',
  component: FixtureApp,
  // Two panes; `prefix s` opens the tree column beside them.
  args: {
    fixture: asFixture(tree),
    start: 'closed',
    transitions: [{ match: /^split-window\b.*@tmuxy-window-type sidebar-left$/, to: 'open' }],
  },
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
type Story = StoryObj<typeof FixtureApp>;

const colourOf = (el: Element) => getComputedStyle(el).color;

export const TheAccentFollowsTheKeyboard: Story = {
  parameters: {
    docs: {
      story: { inline: false, iframeHeight: 500 },
      description: {
        story:
          'With the keyboard in the panes the active pane’s outline wears the accent; opening the tree column and focusing it hands it to the column’s title, and leaving the column takes it back. The current tab stays the theme’s white throughout. Asserted on the painted colours, with the theme’s own tokens as the expected values — a rule that never applied would pass a class check.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole('group', { name: /^Pane /i }, { timeout: 8000 });

    const root = canvasElement.querySelector<HTMLElement>('.app-container')!;
    // Not every theme sets an accent apart from its white — gruvbox's is
    // yellow, the default's is the white itself — so the story gives itself a
    // distinguishable one. What is under test is which surface reads the
    // token, not what a particular theme puts in it.
    document.documentElement.style.setProperty('--theme-accent', 'rgb(215, 153, 33)');
    const style = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    canvasElement.appendChild(probe);
    probe.style.color = style.getPropertyValue('--theme-accent').trim();
    const accentPainted = colourOf(probe);
    probe.style.color = style.getPropertyValue('--text-strong').trim();
    const whitePainted = colourOf(probe);
    probe.remove();
    expect(accentPainted).not.toBe(whitePainted);

    const activeTab = () => canvasElement.querySelector<HTMLElement>('.tab-name-active')!;
    const activePane = () =>
      canvasElement.querySelector<HTMLElement>('.pane-layout-item.pane-active')!;
    // Keyboard in the panes: the active pane's outline wears the accent, the
    // current tab the white.
    expect(root).not.toHaveClass('has-sidebar-focus');
    await waitFor(() => {
      expect(getComputedStyle(activePane()).outlineColor).toBe(accentPainted);
      expect(colourOf(activeTab())).toBe(whitePainted);
    });

    // Open the tree column and focus it.
    await userEvent.keyboard('{Control>}a{/Control}s');
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
      // The column's title has it now; the tab is still the white.
      expect(colourOf(title)).toBe(accentPainted);
      expect(colourOf(activeTab())).toBe(whitePainted);
    });

    // Back to the panes the way the tree offers it — l / → leaves the column,
    // and the title gives the accent back to the pane.
    await userEvent.keyboard('l');
    await waitFor(() => {
      expect(root).not.toHaveClass('has-sidebar-focus');
      expect(colourOf(title)).not.toBe(accentPainted);
      expect(getComputedStyle(activePane()).outlineColor).toBe(accentPainted);
      expect(colourOf(activeTab())).toBe(whitePainted);
    });
    document.documentElement.style.removeProperty('--theme-accent');
  },
};
