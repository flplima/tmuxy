import { describe, it, expect } from 'vitest';
import { MODE_HINTS, normalHints, hintLineText } from '../statusLineHints';

/**
 * The status line is monospace, so a line's width is its length in columns.
 * Every line has to fit an 80-column pty with 1ch of padding either side.
 * A mode's chip adds its 3px padding each side (under one column); the right
 * end's two labels carry their own padding and gap (under three columns).
 */
const COLUMNS = 80 - 2;
const CHIP_PADDING = 1;
const RIGHT_END_SPACING = 3;

describe('status line hints', () => {
  it('normal mode fits beside a host and a session', () => {
    const left = hintLineText(normalHints('ctrl+a', 'ctrl+hjkl'));
    expect(left).toBe('[ctrl+a] prefix · [ctrl+hjkl] panes · [ctrl+1-9] tabs');
    const right = 'localhost [tmuxy]';
    expect(left.length + RIGHT_END_SPACING + right.length).toBeLessThanOrEqual(COLUMNS);
  });

  it.each(Object.entries(MODE_HINTS))('%s mode fits after its chip', (mode, hints) => {
    const line = hintLineText(hints, mode.toUpperCase());
    expect(line.length + CHIP_PADDING).toBeLessThanOrEqual(COLUMNS);
    // No line says how to leave: esc leaves every mode.
    expect(line).not.toMatch(/\besc\b/i);
  });
});
