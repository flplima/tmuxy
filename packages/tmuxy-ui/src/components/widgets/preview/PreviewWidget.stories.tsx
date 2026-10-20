/**
 * The `preview` widget over a recording of real tmux: `tmuxy open notes.md`
 * typed in a pane (`fixtures/scenarios/preview-notes.ts`), and the document
 * the widget read through tmuxy (`read_preview`) recorded with it.
 *
 * Following the file as it changes, a page in its sandboxed frame and Ctrl+C
 * back to the shell are tests/14-widget-preview.test.js, end to end.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor } from 'storybook/test';
import { FixtureApp } from '../../../stories/FixtureHarness';
import { asFixture } from '../../../stories/fixtures/FixtureAdapter';
import preview from '../../../stories/fixtures/gen/preview-notes.json';
import { channels } from '../../../stories/colorChannels';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Preview Widget',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: { fixture: asFixture(preview), start: 'previewing' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

const pane = (id: string) =>
  document.querySelector(`.pane-wrapper[data-pane-id="${id}"]`) as HTMLElement | null;

/** The pane on screen and `el` inside it, both with a real box. */
function expectVisibleIn(el: Element | null, container: Element | null) {
  expect(el).not.toBeNull();
  expect(container).not.toBeNull();
  const box = el!.getBoundingClientRect();
  const frame = container!.getBoundingClientRect();
  expect(box.height).toBeGreaterThan(0);
  expect(box.width).toBeGreaterThan(0);
  expect(box.top).toBeGreaterThanOrEqual(frame.top - 1);
  expect(box.top).toBeLessThan(frame.bottom);
}

export const MarkdownWithMermaid: Story = {
  play: async () => {
    const user = userEvent.setup();

    // The document is drawn in the pane, in the theme's colours.
    await waitFor(
      () => {
        const heading = pane('%0')?.querySelector('.preview-markdown h1') ?? null;
        expect(heading?.textContent).toBe('Preview Title');
        expectVisibleIn(heading, pane('%0'));
      },
      { timeout: 20000 },
    );
    const heading = pane('%0')!.querySelector('.preview-markdown h1')!;
    const primary = getComputedStyle(document.documentElement).getPropertyValue('--text-primary');
    expect(channels(getComputedStyle(heading).color)).toEqual(channels(primary));
    // The pane is named after the file.
    expect(pane('%0')!.querySelector('.pane-header')?.textContent).toContain('notes.md');

    // The mermaid fence is a diagram, with its labels.
    await waitFor(
      () => {
        const svg = pane('%0')!.querySelector('.preview-mermaid svg');
        expectVisibleIn(svg, pane('%0'));
        expect(svg!.textContent).toContain('Start');
      },
      { timeout: 20000 },
    );

    // The text is the page's to select, natively.
    const paragraph = pane('%0')!.querySelector('.preview-markdown p')!;
    expect(getComputedStyle(paragraph).userSelect).toBe('text');
    await user.pointer([
      { keys: '[MouseLeft>]', target: paragraph, offset: 0 },
      { target: paragraph, offset: 4 },
      { keys: '[/MouseLeft]' },
    ]);
    expect(window.getSelection()?.toString()).toBe('Some');
  },
};
