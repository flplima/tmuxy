/**
 * Applies the backend's appearance settings (tmuxy.conf `@tmuxy-*` opacities)
 * as the CSS variables the stylesheets compose their backgrounds with. The
 * defaults live in standalone.css so the look holds before the backend answers
 * and in adapters without a config (demo, v86).
 */

import type { Appearance } from '../domain/wire';

type OpacityKey =
  | 'opacity'
  | 'activePaneOpacity'
  | 'inactivePaneOpacity'
  | 'activeTextOpacity'
  | 'inactiveTextOpacity';

/** Each opacity's variable, and whether it is a surface the window shows through. */
const VARIABLES: Array<[OpacityKey, string, boolean]> = [
  ['opacity', '--app-opacity', true],
  ['activePaneOpacity', '--active-pane-opacity', true],
  ['inactivePaneOpacity', '--inactive-pane-opacity', true],
  ['activeTextOpacity', '--active-text-opacity', false],
  ['inactiveTextOpacity', '--inactive-text-opacity', false],
];

export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement.style;
  // With transparency off the surfaces paint opaque; the text's dim is the
  // focus cue, not transparency, and stays.
  const opaque = appearance.transparency === false;
  for (const [key, variable, surface] of VARIABLES) {
    root.setProperty(variable, opaque && surface ? '1' : String(appearance[key]));
  }
}
