import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SETTLE_TAG } from '../commandHelpers';

describe('the settle tag', () => {
  // The server reads the tag off the run-shell a multi-step script starts
  // with (tmuxy-core tmux_compat::SETTLE_TAG); spelled otherwise here, the
  // clients would draw every intermediate step of a group change.
  it('is the one the server reads', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, '../../../../tmuxy-core/src/tmux_compat.rs'), 'utf8');
    expect(rust).toContain(`pub const SETTLE_TAG: &str = "${SETTLE_TAG}";`);
  });
});
