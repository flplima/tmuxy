/**
 * Applies the backend's appearance settings (tmuxy.conf `@tmuxy-*` opacities)
 * as the CSS variables the stylesheets compose their backgrounds with. The
 * defaults live in standalone.css so the look holds before the backend answers
 * and in adapters without a config (demo, v86).
 */

import type { Appearance } from '../tmux/types';

const VARIABLES: Array<[keyof Appearance, string]> = [
  ['opacity', '--app-opacity'],
  ['activePaneOpacity', '--active-pane-opacity'],
  ['inactivePaneOpacity', '--inactive-pane-opacity'],
  ['activeTextOpacity', '--active-text-opacity'],
  ['inactiveTextOpacity', '--inactive-text-opacity'],
];

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement.style;
  for (const [key, variable] of VARIABLES) {
    root.setProperty(variable, String(appearance[key]));
  }
}
