/**
 * The layout arithmetic's copies of stylesheet values, held to the
 * stylesheet. Timings are read from the computed style where they are used
 * (`infra/dom/cssTiming.ts`); these are the lengths the machines' pure
 * geometry needs as numbers before any element exists.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  CHAR_HEIGHT,
  CONTAINER_PADDING_BOTTOM,
  CONTAINER_PADDING_X,
  PHONE_CONTAINER_PADDING,
} from '../../constants/layout';
import { PANE_OUTLINE_PX } from '../../domain/paneGeometry';
import { MODAL_HEADER_HEIGHT } from '../Modal';
import { DEFAULT_APPEARANCE } from '../../domain/tmuxyConstants.gen';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const css = (path: string) => readFileSync(resolve(SRC, path), 'utf8');

/** The value in `unit` `declaration` (`--x` or `prop`) has in the first rule `selector` opens. */
function px(file: string, selector: string, declaration: string, unit = 'px'): number {
  const text = css(file);
  const start = text.indexOf(`${selector} {`);
  expect(start, `${selector} in ${file}`).toBeGreaterThanOrEqual(0);
  const rule = text.slice(start, text.indexOf('}', start));
  const m = rule.match(
    new RegExp(`(?:^|[\\s;{])${declaration}:\\s*(-?\\d+(?:\\.\\d+)?)${unit}(?![\\d.%a-z])`),
  );
  expect(m, `${declaration} in ${selector}`).not.toBeNull();
  return Number(m![1]);
}

describe('stylesheet values the layout arithmetic copies', () => {
  it('a terminal row is CHAR_HEIGHT tall', () => {
    expect(px('styles.css', ':root', '--line-height-terminal')).toBe(CHAR_HEIGHT);
  });

  it('the pane container is padded by CONTAINER_PADDING_X / _BOTTOM, and on the phone by PHONE_CONTAINER_PADDING', () => {
    expect(px('styles.css', ':root', '--pane-container-padding-x')).toBe(CONTAINER_PADDING_X);
    expect(px('styles.css', ':root', '--pane-container-padding-bottom')).toBe(
      CONTAINER_PADDING_BOTTOM,
    );
    const phone = '.app-body-phone .phone-pty .pane-container';
    expect(px('styles/phone.css', phone, '--pane-container-padding-x')).toBe(
      PHONE_CONTAINER_PADDING,
    );
    expect(px('styles/phone.css', phone, '--pane-container-padding-bottom')).toBe(
      PHONE_CONTAINER_PADDING,
    );
  });

  it('a pane draws its outline PANE_OUTLINE_PX outside its box', () => {
    expect(px('styles/pane-layout.css', '.pane-layout-item', 'outline')).toBe(PANE_OUTLINE_PX);
  });

  it('the opacities before the backend answers are DEFAULT_APPEARANCE', () => {
    const root = (variable: string) => px('styles.css', ':root', variable, '');
    expect(root('--app-opacity')).toBe(DEFAULT_APPEARANCE.opacity);
    expect(root('--active-pane-opacity')).toBe(DEFAULT_APPEARANCE.activePaneOpacity);
    expect(root('--inactive-pane-opacity')).toBe(DEFAULT_APPEARANCE.inactivePaneOpacity);
    expect(root('--active-text-opacity')).toBe(DEFAULT_APPEARANCE.activeTextOpacity);
    expect(root('--inactive-text-opacity')).toBe(DEFAULT_APPEARANCE.inactiveTextOpacity);
  });

  it('a modal header is MODAL_HEADER_HEIGHT tall', () => {
    expect(px('components/Modal.css', '.modal-header', 'height')).toBe(MODAL_HEADER_HEIGHT);
  });
});
