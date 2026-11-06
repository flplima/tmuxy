/**
 * The app shell on every theme face (seven themes, dark and light) over one
 * recording of real tmux: a tab `main` split side by side, the new pane having
 * printed a 256-colour cell. Each story checks the face's tokens arrive where
 * the design paints them; the probe's axe pass reads the same page for
 * contrast. What the values must be is `infra/__tests__/themeFaces.test.ts`.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor } from 'storybook/test';
import { FixtureApp } from './FixtureHarness';
import { asFixture } from './fixtures/FixtureAdapter';
import themeFaceSplit from './fixtures/gen/theme-face-split.json';
import { channels } from './colorChannels';

const meta: Meta<typeof FixtureApp> = {
  title: 'Mocked App/Theme Faces',
  component: FixtureApp,
  args: { fixture: asFixture(themeFaceSplit), start: 'split' },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The app shell — tab strip, a split, the status line — on each theme face, painted from that face’s tokens.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof FixtureApp>;

type Theme =
  | 'catppuccin'
  | 'default'
  | 'dracula'
  | 'fallout'
  | 'gruvbox'
  | 'nord'
  | 'solarized'
  | 'tokyonight';
type Mode = 'dark' | 'light';

const app = () =>
  (window as unknown as { app: { send(event: { type: string; [k: string]: unknown }): void } }).app;

/**
 * Read off the root rather than a probe element: `waitFor` re-runs on every
 * DOM mutation, and adding a probe inside it would re-trigger it forever.
 */
function token(name: string): number[] {
  return channels(getComputedStyle(document.documentElement).getPropertyValue(name));
}

function paint(el: Element, property: 'color' | 'outlineColor' | 'backgroundColor'): number[] {
  return channels(getComputedStyle(el)[property]);
}

function face(theme: Theme, mode: Mode): Story {
  return {
    parameters: { docs: { story: { inline: false, iframeHeight: 600 } } },
    play: async ({ canvasElement }) => {
      await waitFor(
        () => expect(canvasElement.querySelectorAll('.pane-layout-item').length).toBe(2),
        { timeout: 8000 },
      );

      // The old face's sheet stays in force until the new one loads, in a link
      // of its own that takes the `tmuxy-theme` id only once it has
      // (themeManager): that id on the new href says the face is in.
      app().send({ type: 'SET_THEME', name: theme });
      app().send({ type: 'SET_THEME_MODE', mode });
      await waitFor(
        () =>
          expect(document.getElementById('tmuxy-theme')?.getAttribute('href')).toBe(
            `/themes/${theme}.css`,
          ),
        { timeout: 8000 },
      );
      const link = document.getElementById('tmuxy-theme') as HTMLLinkElement;
      const html = document.documentElement;
      expect(link.getAttribute('href')).toBe(`/themes/${theme}.css`);
      expect(html.classList.contains(`theme-${mode}`)).toBe(true);

      const tab = canvasElement.querySelector('.tab-name-active') as HTMLElement;
      const activePane = canvasElement.querySelector(
        '.pane-layout-item.pane-active',
      ) as HTMLElement;
      const status = canvasElement.querySelector('.tmux-status-bar') as HTMLElement;
      // The old face stays applied for a beat after the new sheet loads, and
      // the chrome's colours transition into the new face's.
      await waitFor(
        () => {
          const accent = token('--theme-accent');
          expect(paint(tab, 'color')).toEqual(accent);
          expect(paint(activePane, 'outlineColor')).toEqual(accent);
          expect(paint(status, 'backgroundColor')).toEqual(token('--tmux-status-bg'));
          expect(paint(activePane, 'backgroundColor')).toEqual(token('--term-background'));
        },
        { timeout: 5000, interval: 100 },
      );

      // A 256-colour cell (196, pure red) draws --term-extended-colors of its own
      // colour and the rest its lightness (21%) between the pane's foreground
      // and background: red on most faces, a blend of the two on a monochrome one.
      const cell = [...activePane.querySelectorAll('span')].find(
        (span) => span.textContent === 'RED196',
      );
      if (!cell) throw new Error('the active pane drew no RED196 cell');
      expect(cell.getBoundingClientRect().width).toBeGreaterThan(0);
      const share =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--term-extended-colors'),
        ) / 100;
      const fg = token('--term-foreground');
      const bg = token('--term-background');
      const expected = [255, 0, 0].map(
        (c, i) => c * share + (bg[i] + (fg[i] - bg[i]) * 0.21) * (1 - share),
      );
      const painted = paint(cell, 'color');
      painted.forEach((c, i) => expect(Math.abs(c - expected[i])).toBeLessThanOrEqual(1));

      // Nothing still fading in: the probe's contrast pass reads what is
      // painted when the story ends. Transitions only: the cursor's blink never
      // ends.
      await waitFor(
        () =>
          expect(
            document
              .getAnimations()
              .filter((a) => a instanceof CSSTransition && a.playState === 'running'),
          ).toEqual([]),
        { timeout: 5000, interval: 100 },
      );
    },
  };
}

export const CatppuccinDark = face('catppuccin', 'dark');
export const CatppuccinLight = face('catppuccin', 'light');
export const DefaultDark = face('default', 'dark');
export const DefaultLight = face('default', 'light');
export const DraculaDark = face('dracula', 'dark');
export const DraculaLight = face('dracula', 'light');
export const FalloutDark = face('fallout', 'dark');
export const FalloutLight = face('fallout', 'light');
export const GruvboxDark = face('gruvbox', 'dark');
export const GruvboxLight = face('gruvbox', 'light');
export const NordDark = face('nord', 'dark');
export const NordLight = face('nord', 'light');
export const SolarizedDark = face('solarized', 'dark');
export const SolarizedLight = face('solarized', 'light');
export const TokyonightDark = face('tokyonight', 'dark');
export const TokyonightLight = face('tokyonight', 'light');
