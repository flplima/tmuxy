/**
 * The theme's accent marks the surface that has the keyboard: the active
 * pane's outline, or the sidebar column's title; the current tab wears it
 * wherever the keyboard is. Over states recorded from real tmux.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within, waitFor, userEvent } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import tree from './fixtures/gen/tree.json';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Focus Accent',
  component: FixtureApp,
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
          'With the keyboard in the panes the active pane’s outline wears the accent; opening the tree column and focusing it hands it to the column’s title, and leaving the column takes it back. The current tab wears the accent throughout. Asserted on the painted colours, with the theme’s own tokens as the expected values — a rule that never applied would pass a class check.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findAllByRole('group', { name: /^Pane /i }, { timeout: 8000 });

    const root = canvasElement.querySelector<HTMLElement>('.app-container')!;
    // The default theme's accent is its white, so the story sets a
    // distinguishable one: what is under test is which surface reads the token.
    document.documentElement.style.setProperty('--theme-accent', 'rgb(215, 153, 33)');
    const style = getComputedStyle(document.documentElement);
    const probe = document.createElement('span');
    canvasElement.appendChild(probe);
    probe.style.color = style.getPropertyValue('--theme-accent').trim();
    const accentPainted = colourOf(probe);
    probe.remove();

    const activeTab = () => canvasElement.querySelector<HTMLElement>('.tab-name-active')!;
    const activePane = () =>
      canvasElement.querySelector<HTMLElement>('.pane-layout-item.pane-active')!;
    expect(root).not.toHaveClass('has-sidebar-focus');
    await waitFor(() => {
      expect(getComputedStyle(activePane()).outlineColor).toBe(accentPainted);
      expect(colourOf(activeTab())).toBe(accentPainted);
    });

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
      expect(colourOf(title)).toBe(accentPainted);
      expect(colourOf(activeTab())).toBe(accentPainted);
    });

    // l / → leaves the column, the way the tree offers it.
    await userEvent.keyboard('l');
    await waitFor(() => {
      expect(root).not.toHaveClass('has-sidebar-focus');
      expect(colourOf(title)).not.toBe(accentPainted);
      expect(getComputedStyle(activePane()).outlineColor).toBe(accentPainted);
      expect(colourOf(activeTab())).toBe(accentPainted);
    });
    document.documentElement.style.removeProperty('--theme-accent');
  },
};
