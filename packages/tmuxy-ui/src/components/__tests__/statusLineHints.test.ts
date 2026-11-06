import { describe, it, expect } from 'vitest';
import { modeHints, normalHints, hintLineText } from '../statusLineHints';
import { DEFAULT_KEYBINDINGS } from '../../infra/transport/drivers/guest/defaultKeybindings';
import type { KeyBindings } from '../../domain/wire';

/**
 * The status line is monospace, so a line's width is its length in columns.
 * Every line has to fit an 80-column pty with 1ch of padding either side.
 * A mode's chip adds its 3px padding each side (under one column); the right
 * end's two labels carry their own padding and gap (under three columns).
 */
const COLUMNS = 80 - 2;
const CHIP_PADDING = 1;
const RIGHT_END_SPACING = 3;

/** The shipped config's bindings, with the PANE keys the guest leaves out put back. */
const BINDINGS: KeyBindings = {
  ...DEFAULT_KEYBINDINGS,
  tables: {
    ...DEFAULT_KEYBINDINGS.tables,
    pane: [
      ...(DEFAULT_KEYBINDINGS.tables.pane ?? []),
      {
        key: 's',
        command: 'run-shell "bash $TMUXY_DATA_DIR/bin/tmuxy/stack new #{pane_id}"',
        description: '',
      },
    ],
  },
};

describe('status line hints', () => {
  it('normal mode names the bound keys and fits beside a host and a session', () => {
    const left = hintLineText(normalHints(BINDINGS));
    expect(left).toBe('[ctrl+a] prefix · [ctrl+hjkl] panes · [ctrl+1-9] tabs');
    const right = 'localhost [tmuxy]';
    expect(left.length + RIGHT_END_SPACING + right.length).toBeLessThanOrEqual(COLUMNS);
  });

  it('reads each mode’s keys from what its table binds', () => {
    expect(hintLineText(modeHints(BINDINGS, 'prefix'))).toBe(
      '[-|] split · [c] new tab · [p] pane · [t] tab · [s/S] sidebars',
    );
    expect(hintLineText(modeHints(BINDINGS, 'pane'))).toBe(
      '[hjkl] focus · [-|] split · [x] close · [z] zoom · [s] stack',
    );
    expect(hintLineText(modeHints(BINDINGS, 'tab'))).toBe(
      '[hl] prev/next · [c] new · [,] rename · [x] close · [1-9] go',
    );
    // A key the config does not bind is not offered.
    expect(modeHints(DEFAULT_KEYBINDINGS, 'pane').map((h) => h.label)).not.toContain('stack');
    expect(modeHints(BINDINGS, 'nosuchtable')).toEqual([]);
  });

  it.each(['prefix', 'copy', 'pane', 'tab'])('%s mode fits after its chip', (mode) => {
    const line = hintLineText(modeHints(BINDINGS, mode), mode.toUpperCase());
    expect(line.length + CHIP_PADDING).toBeLessThanOrEqual(COLUMNS);
    // No line says how to leave: esc leaves every mode.
    expect(line).not.toMatch(/\besc\b/i);
  });
});
