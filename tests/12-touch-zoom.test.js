/**
 * The phone's zoom, finger only, with the keyboard up and down.
 *
 * Zoomed by the key row's magnifier, the terminal is drawn at twice its size.
 * Upright, the bottom view gives way so every row is on screen and the view
 * scrolls sideways only, with the key row under it. Held sideways, the
 * doubled grid is taller than the screen and scrolls both ways. Either way a
 * keyboard coming up cuts the terminal short, and it scrolls to keep the
 * cursor's row in view above the keyboard (hooks/usePhoneViewport.ts).
 *
 * A headless browser draws no keyboard and never shrinks its visual viewport,
 * so the suite brings up a mock one that does both (helpers/keyboard-mock.js).
 * Every assertion is about boxes on screen.
 */

const {
  PHONE,
  usePhoneContext,
  typeOnVirtualKeyboard,
  keyRowCentre,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const { showKeyboard, hideKeyboard } = require('./helpers/keyboard-mock');
const { waitForCondition } = require('./helpers');

const SIDEWAYS = { width: 844, height: 390 };

/** The cursor's box, the terminal's and the keyboard's, read together. */
const cursorAndKeyboard = (page) =>
  page.evaluate(() => {
    const box = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    return {
      cursor: box(document.querySelector('.phone-pty .pane-active .terminal-cursor')),
      term: box(document.querySelector('.phone-pty')),
      keyboard: box(document.querySelector('[data-testid="mock-keyboard"]')),
      keys: box(document.querySelector('.key-row')),
    };
  });

/** The cursor's row inside the terminal and above the keyboard. */
const cursorInView = ({ cursor, term, keyboard }) =>
  !!cursor &&
  cursor.height > 0 &&
  cursor.top >= term.top - 0.5 &&
  cursor.bottom <= term.bottom + 0.5 &&
  cursor.bottom <= keyboard.top + 0.5;

/** Tap the magnifier and wait for the zoom to be on (or off). */
async function toggleZoom(page, on) {
  const key = await keyRowCentre(page, 'zoom');
  await page.touchscreen.tap(key.x, key.y);
  await waitForCondition(
    page,
    () =>
      page.evaluate(() => !!document.querySelector('.phone-pty.is-zoomed')).then((z) => z === on),
    5000,
    `the zoom to turn ${on ? 'on' : 'off'}`,
  );
}

/** Open the phone's keyboard with the ⌨ key, then bring the mock up. */
async function keyboardUp(page, height) {
  const key = await keyRowCentre(page, '⌨');
  await page.touchscreen.tap(key.x, key.y);
  await waitForCondition(
    page,
    () => page.evaluate(() => document.activeElement?.tagName === 'INPUT'),
    5000,
    'the ⌨ key to open the keyboard',
  );
  await showKeyboard(page, height);
}

describe('Phone upright (390x844): the zoom shows every row, and the keyboard keeps the cursor in view', () => {
  const ctx = usePhoneContext(PHONE);

  test('zoom → the bottom view gives way, every row on screen at twice its size, sideways scroll only → keyboard up → the cursor row stays above it → zoom off', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();
    await waitForPhoneGrid(ctx.page);
    const before = await boxOf(ctx.page, '.phone-pty .pane-container');

    await toggleZoom(ctx.page, true);
    const zoomed = await ctx.page.evaluate(() => {
      const box = (el) => el.getBoundingClientRect().toJSON();
      const viewport = document.querySelector('.phone-zoom-viewport');
      const term = document.querySelector('.phone-pty');
      const lines = [...document.querySelectorAll('.phone-pty .pane-active .terminal-line')];
      return {
        bottomView: !!document.querySelector('[data-testid="phone-bottom"]'),
        lines: lines.length,
        first: box(lines[0]),
        last: box(lines[lines.length - 1]),
        viewport: box(viewport),
        keys: box(document.querySelector('.key-row')),
        sideways: viewport.scrollWidth - viewport.clientWidth,
        upright: viewport.scrollHeight - viewport.clientHeight,
        termUpright: term.scrollHeight - term.clientHeight,
      };
    });
    expect(zoomed.bottomView).toBe(false);
    expect(zoomed.lines).toBeGreaterThanOrEqual(23);
    expect(zoomed.first.height).toBeGreaterThan(before.height / 24 + 2);
    expect(zoomed.last.bottom).toBeLessThanOrEqual(zoomed.viewport.bottom + 0.5);
    expect(zoomed.last.bottom).toBeLessThanOrEqual(zoomed.keys.top + 0.5);
    expect(zoomed.keys.bottom).toBeLessThanOrEqual(PHONE.height + 0.5);
    expect(zoomed.sideways).toBeGreaterThan(10);
    expect(zoomed.upright).toBeLessThanOrEqual(1);
    expect(zoomed.termUpright).toBeLessThanOrEqual(1);

    // The keyboard comes up: a few lines typed, and the row being typed on
    // stays in view above it, the keys too.
    await keyboardUp(ctx.page, 300);
    await typeOnVirtualKeyboard(ctx.page, 'echo ZOOM_KEYBOARD_OK\n');
    let last = null;
    await waitForCondition(
      ctx.page,
      async () => {
        last = await cursorAndKeyboard(ctx.page);
        return cursorInView(last) && last.keys.bottom <= last.keyboard.top + 0.5;
      },
      10000,
      () => `the cursor's row in view above the keyboard (last: ${JSON.stringify(last)})`,
    );

    await hideKeyboard(ctx.page);
    await toggleZoom(ctx.page, false);
    expect(await boxOf(ctx.page, '[data-testid="phone-bottom"]')).not.toBeNull();
  }, 120000);
});

describe('Phone sideways (844x390): zoomed, the keyboard keeps the cursor in view', () => {
  const ctx = usePhoneContext(SIDEWAYS);

  test('zoom → the doubled grid scrolls both ways beside the column → keyboard up → the cursor row stays above it', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();
    await waitForPhoneGrid(ctx.page);

    await toggleZoom(ctx.page, true);
    const zoomed = await ctx.page.evaluate(() => {
      const viewport = document.querySelector('.phone-zoom-viewport');
      const term = document.querySelector('.phone-pty');
      return {
        sideways: viewport.scrollWidth - viewport.clientWidth,
        upright: term.scrollHeight - term.clientHeight,
        bottomView: !!document.querySelector('.phone-side [data-testid="phone-bottom"]'),
      };
    });
    expect(zoomed.sideways).toBeGreaterThan(10);
    expect(zoomed.upright).toBeGreaterThan(10);
    expect(zoomed.bottomView).toBe(true);

    await keyboardUp(ctx.page, 170);
    await typeOnVirtualKeyboard(ctx.page, 'echo SIDEWAYS_ZOOM_OK\n');
    let last = null;
    await waitForCondition(
      ctx.page,
      async () => {
        last = await cursorAndKeyboard(ctx.page);
        return cursorInView(last) && last.term.bottom <= last.keyboard.top + 0.5;
      },
      10000,
      () => `the cursor's row in view above the keyboard (last: ${JSON.stringify(last)})`,
    );
    await hideKeyboard(ctx.page);
  }, 120000);
});
