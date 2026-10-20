/**
 * FloatPane stories, over a recording of real tmux.
 *
 * The floats are the ones `tmuxy pane float` opened in a pane
 * (`fixtures/scenarios/float-variants.ts`): every drawer edge, every
 * backdrop, a float with no header and one sized in columns. What tmux holds
 * of each is its window's `@tmuxy-float-*` tags, and these stories assert
 * what the app draws from them.
 *
 * A float's overlay is rendered inside the pane container, not portaled to the
 * body, so its backdrop dims the tab's content and leaves the sidebars, the tab
 * strip and the status line alone.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { FixtureApp } from '../stories/FixtureHarness';
import { asFixture } from '../stories/fixtures/FixtureAdapter';
import floats from '../stories/fixtures/gen/float-variants.json';
import { charWidthPx } from '../stories/appStoryHelpers';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/FloatPane',
  component: FixtureApp,
  parameters: { layout: 'fullscreen' },
  args: { fixture: asFixture(floats), start: 'every-float' },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

/** The overlay of each float, by the pane it holds, in the order they were opened. */
const FLOAT_OVERLAYS: ReadonlyArray<[string, string]> = [
  ['%1', '.modal-overlay.float-modal:has(.float-container[data-pane-id="%1"])'],
  ['%2', '.modal-overlay.drawer-left'],
  ['%3', '.modal-overlay.drawer-bottom'],
  ['%4', '.modal-overlay.drawer-right'],
  ['%5', '.modal-overlay.drawer-top'],
  ['%6', '.modal-overlay.float-modal:has(.float-container[data-pane-id="%6"])'],
  ['%7', '.modal-overlay.float-modal:has(.float-container[data-pane-id="%7"])'],
];

const overlay = (pane: string) =>
  document.querySelector<HTMLElement>(FLOAT_OVERLAYS.find(([id]) => id === pane)![1]);
const box = (pane: string) =>
  overlay(pane)!.querySelector('.modal-container')!.getBoundingClientRect();
const backdrop = (pane: string) => overlay(pane)!.querySelector('.modal-backdrop')!;

export const MultipleFloats: Story = {
  parameters: {
    docs: {
      description: {
        story:
          'Seven floats over one tab: centred on the dim backdrop, a left drawer with none, a bottom drawer with blur, right and top drawers, a centred float with `--hide-header`, and one opened `--width 40`. Each drawer is flush with its own edge of the tab and runs its whole length, the float opened later stacks over the one before it, `--hide-header` takes the header away, and a width in columns is drawn in columns.',
      },
    },
  },
  play: async () => {
    await waitFor(
      () => {
        expect(document.querySelectorAll('.modal-overlay').length).toBe(FLOAT_OVERLAYS.length);
        for (const [pane] of FLOAT_OVERLAYS) expect(overlay(pane), pane).not.toBeNull();
      },
      { timeout: 8000 },
    );

    // Each drawer slides in onto its own edge of the tab.
    const tab = document.querySelector('.pane-container')!.getBoundingClientRect();
    const near = (a: number, b: number) => Math.abs(a - b) <= 1;
    await waitFor(
      () => {
        expect(near(box('%2').left, tab.left), 'left drawer on the left edge').toBe(true);
        expect(near(box('%3').bottom, tab.bottom), 'bottom drawer on the bottom edge').toBe(true);
        expect(near(box('%4').right, tab.right), 'right drawer on the right edge').toBe(true);
        expect(near(box('%5').top, tab.top), 'top drawer on the top edge').toBe(true);
      },
      { timeout: 8000 },
    );
    // ...and runs the whole length of it, padding included.
    expect(near(box('%2').height, tab.height), 'left drawer spans the tab').toBe(true);
    expect(near(box('%3').width, tab.width), 'bottom drawer spans the tab').toBe(true);
    expect(near(box('%4').height, tab.height), 'right drawer spans the tab').toBe(true);
    expect(near(box('%5').width, tab.width), 'top drawer spans the tab').toBe(true);

    // The float opened later stacks over the one opened before it.
    const z = FLOAT_OVERLAYS.map(([pane]) => Number(overlay(pane)!.style.zIndex));
    for (let i = 1; i < z.length; i++) {
      expect(z[i], `${FLOAT_OVERLAYS[i][0]} over ${FLOAT_OVERLAYS[i - 1][0]}`).toBeGreaterThan(
        z[i - 1],
      );
    }

    // The backdrops: dim by default, none and blur where asked.
    expect(backdrop('%1').className).toBe('modal-backdrop');
    expect(backdrop('%2')).toHaveClass('modal-backdrop-none');
    expect(backdrop('%3')).toHaveClass('modal-backdrop-blur');

    // The header: on the default float, gone from the `--hide-header` one.
    const header = overlay('%1')!.querySelector('.pane-header');
    expect(header).not.toBeNull();
    expect(header!.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(overlay('%6')!.querySelector('.pane-header, .modal-header')).toBeNull();

    // `--width 40` is forty of the terminal's columns.
    expect(Math.abs(box('%7').width - 40 * charWidthPx())).toBeLessThanOrEqual(2);
  },
};
