/**
 * The app shell on every theme face (demo engine): eight themes, dark and
 * light, sixteen stories.
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
import { AppHarness } from './StoryHarness';

const meta: Meta<typeof AppHarness> = {
  title: 'Mocked App/Theme Faces',
  component: AppHarness,
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
type Story = StoryObj<typeof AppHarness>;

type Theme =
  | 'default'
  | 'cold-harbor'
  | 'dracula'
  | 'fallout'
  | 'gruvbox'
  | 'nord'
  | 'solarized'
  | 'tokyonight';
type Mode = 'dark' | 'light';

const app = () =>
  (window as unknown as { app: { send(event: { type: string; [k: string]: unknown }): void } }).app;

/** A colour's red, green and blue on 0–255: hex, `rgb()` or `color(srgb …)`. */
function channels(colour: string): number[] {
  const hex = colour.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const srgb = colour.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map((c) => Math.round(Number(c) * 255));
  return (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((c) => Math.round(Number(c)));
}

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
    args: { height: 520, initCommands: ['rename-window main', 'split-window -h'] },
    parameters: { docs: { story: { inline: false, iframeHeight: 520 } } },
    play: async ({ canvasElement }) => {
      await waitFor(
        () => expect(canvasElement.querySelectorAll('.pane-layout-item').length).toBe(2),
        { timeout: 8000 },
      );

      app().send({ type: 'SET_THEME', name: theme });
      app().send({ type: 'SET_THEME_MODE', mode });
      const html = document.documentElement;
      await waitFor(
        () => {
          const link = document.getElementById('tmuxy-theme') as HTMLLinkElement | null;
          expect(link?.getAttribute('href')).toBe(`/themes/${theme}.css`);
          expect(link?.sheet).toBeTruthy();
          expect(html.classList.contains(`theme-${mode}`)).toBe(true);
        },
        { timeout: 8000, interval: 100 },
      );

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
    },
  };
}

export const DefaultDark = face('default', 'dark');
export const DefaultLight = face('default', 'light');
export const ColdHarborDark = face('cold-harbor', 'dark');
export const ColdHarborLight = face('cold-harbor', 'light');
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
