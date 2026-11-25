import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clickTerminal } = require('../tests/helpers/browser.js');

// A terminal played by a script: what each measure finds, and whether each
// click lands. No browser.
function terminal({ spots, clicks }) {
  const clicked = [];
  let measured = 0;
  return {
    clicked,
    measures: () => measured,
    evaluate: async () => spots[Math.min(measured++, spots.length - 1)],
    click: async ({ position }) => {
      clicked.push(position);
      if (!clicks[Math.min(clicked.length - 1, clicks.length - 1)]) {
        throw new Error('the status line intercepts pointer events');
      }
    },
  };
}

describe('a click on a terminal that is still settling', () => {
  it('waits for a spot nothing covers before it clicks', async () => {
    const t = terminal({
      spots: [
        { x: 4, y: 400, free: false },
        { x: 4, y: 300, free: true },
      ],
      clicks: [true],
    });
    await clickTerminal(t);
    expect(t.clicked).toEqual([{ x: 4, y: 300 }]);
  });

  it('aims again when the terminal shrank between the measure and the click', async () => {
    const t = terminal({
      spots: [
        { x: 4, y: 400, free: true },
        { x: 4, y: 300, free: true },
      ],
      clicks: [false, true],
    });
    await clickTerminal(t);
    expect(t.clicked).toEqual([
      { x: 4, y: 400 },
      { x: 4, y: 300 },
    ]);
    expect(t.measures()).toBe(2);
  });
});
