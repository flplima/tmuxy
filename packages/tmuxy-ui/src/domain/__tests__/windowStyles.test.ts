/**
 * The Window menu's style slugs against the desktop that accepts them
 * (`packages/tmuxy-tauri-app/src/window_style.rs`, which refuses an unknown
 * slug): a rename on either side would show up only as a menu item that does
 * nothing, and the desktop crate cannot be built in every environment the UI
 * tests run in, so its source is read.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { WINDOW_STYLES } from '../guiWindows';

const WINDOW_STYLE_RS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../tmuxy-tauri-app/src/window_style.rs',
);

describe('window styles', () => {
  it('offers exactly the slugs the desktop accepts, in its order', () => {
    const source = readFileSync(WINDOW_STYLE_RS, 'utf8');
    const slugFn = source.slice(source.indexOf('pub fn slug('));
    const body = slugFn.slice(0, slugFn.indexOf('\n    }\n'));
    const slugs = [...body.matchAll(/=> "([^"]+)"/g)].map((m) => m[1]);
    expect(slugs.length).toBeGreaterThan(0);
    expect(WINDOW_STYLES.map((s) => s.slug)).toEqual(slugs);
  });
});
