import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { scriptWith, type ScriptEffect } from '../commandHelpers';

describe('the script effect markers', () => {
  // The server reads the marker off the run-shell a script starts with
  // (tmuxy-core tmux_compat::SETTLE_TAG, RELIST_TAG); spelled otherwise here,
  // the clients would draw every step of a group change, or keep a stack
  // toggle's stale rows.
  it('are the ones the server reads', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, '../../../../tmuxy-core/src/tmux_compat.rs'), 'utf8');
    const tags: [string, ScriptEffect][] = [
      ['SETTLE_TAG', 'settle'],
      ['RELIST_TAG', 'relist-windows'],
    ];
    for (const [name, effect] of tags) {
      expect(scriptWith(effect, 'x')).toMatch(new RegExp(`^run-shell "TMUXY_EFFECT=${effect} `));
      expect(rust).toContain(`pub const ${name}: &str = "TMUXY_EFFECT=${effect}";`);
    }
  });
});
