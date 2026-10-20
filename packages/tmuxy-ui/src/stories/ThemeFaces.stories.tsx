/**
 * The app shell on every theme face: seven themes, dark and light, fourteen
 * stories, all over one recording of real tmux — a tab named `main` split
 * side by side, the new pane having printed a 256-colour cell.
 *
 * A theme is only a re-declaration of the token names, so each story loads
 * one face and checks the chrome paints those names where the design says:
 * the theme's accent on the current tab and the active pane's outline, the
 * status line on its own band, the panes on the theme's background. The
 * probe's axe pass reads the same painted page for contrast. What the values
 * must be is `utils/__tests__/themeFaces.test.ts`; this is that they arrive.
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

type Theme = 'default' | 'dracula' | 'fallout' | 'gruvbox' | 'nord' | 'solarized' | 'tokyonight';
type Mode = 'dark' | 'light';

const app = () =>
  (window as unknown as { app: { send(event: { type: string; [k: string]: unknown }): void } }).app;

/**
 * A token's colour as channels. Read off the root rather than painted on a
 * probe element: `waitFor` re-runs on every DOM mutation, and a probe added
 * and removed inside it is one, so the check would re-trigger itself forever.
 */
function token(name: string): number[] {
  return channels(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/** A painted colour property of an element, as channels. */
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

      // A link keeps the old face's sheet in force until the new one has
      // loaded, and every check below would pass against the colours being
      // replaced: so the new sheet's `load` is what says the face is in.
      const link = document.getElementById('tmuxy-theme') as HTMLLinkElement;
      const loaded =
        link.getAttribute('href') === `/themes/${theme}.css`
          ? Promise.resolve()
          : new Promise<void>((resolve) =>
              link.addEventListener('load', () => resolve(), { once: true }),
            );
      app().send({ type: 'SET_THEME', name: theme });
      app().send({ type: 'SET_THEME_MODE', mode });
      await Promise.race([
        loaded,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`/themes/${theme}.css never loaded`)), 8000),
        ),
      ]);
      const html = document.documentElement;
      expect(link.getAttribute('href')).toBe(`/themes/${theme}.css`);
      expect(html.classList.contains(`theme-${mode}`)).toBe(true);

      const tab = canvasElement.querySelector('.tab-name-active') as HTMLElement;
      const activePane = canvasElement.querySelector(
        '.pane-layout-item.pane-active',
      ) as HTMLElement;
      const status = canvasElement.querySelector('.tmux-status-bar') as HTMLElement;
      // Retried: the old face stays applied for a beat after the new sheet
      // loads, and the tab's colour transitions into the new accent.
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

      // A 256-colour cell (196, pure red) is the face's too: its own colour
      // for --term-extended-colors of it, the rest its lightness (21%)
      // between the pane's foreground and background — exactly red on most
      // faces, and on a monochrome one a blend of its two colours. The cell
      // is the `RED196` the active pane printed in that colour.
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

      // The face has arrived only once nothing is still fading into it: the
      // chrome's colours transition, and the probe's contrast pass reads what
      // is painted when the story ends — a label half-way from the old face's
      // colour to the new one's. Transitions only: the cursor's blink never
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
