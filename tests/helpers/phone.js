/**
 * A phone in a test: its own touch-enabled Chromium context at a phone's
 * viewport, the virtual keyboard, and the check that a box is on screen.
 * Shared by the touch suites (tests/12-touch*.test.js) — with the finger itself: a drag,
 * a swipe, a hold, and the wait for the phone's grid to settle.
 */

const { createOwnBrowserContext } = require('./own-browser');
const { getBrowser, delay, waitForCondition } = require('./browser');

/** The portrait phone every touch suite starts from. */
const PHONE = { width: 390, height: 844 };

/**
 * Register a suite's hooks for a touch context at `viewport` and return the
 * context. Called inside a `describe`.
 */
function usePhoneContext(viewport) {
  const ctx = createOwnBrowserContext({
    label: 'a touch-enabled Chromium context',
    // Chromium is the browser the whole suite already needs; a missing one is
    // a broken environment, not a skip.
    openBrowser: async () => (await getBrowser())._browser,
    contextOptions: { viewport, hasTouch: true, deviceScaleFactor: 2 },
  });
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  // The browser is the suite-wide shared one; closing it would take the rest
  // of the run with it. Only this suite's own page and context are released.
  afterAll(async () => {
    if (ctx.page) await ctx.page.close().catch(() => {});
    if (ctx.context) await ctx.context.close().catch(() => {});
    ctx.browser = null;
  }, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);
  return ctx;
}

/** Type on the virtual keyboard — into whatever the tap put the focus on. */
async function typeOnVirtualKeyboard(page, text) {
  for (const char of text) {
    await page.keyboard.type(char);
    await delay(15);
  }
}

/**
 * Every box the user should be able to reach has to be inside the screen.
 *
 * Thrown rather than `expect`ed so the geometry reaches the log whole: jest's
 * object diff prints the line that differs and elides the rest, which for a
 * layout that only misbehaves on another machine's fonts leaves "right: false"
 * and no way to tell what produced it.
 */
function expectOnScreen(box, label, width = PHONE.width, diag = {}) {
  const fail = (what) => {
    throw new Error(`${label} ${what}\n${JSON.stringify({ box, ...diag }, null, 2)}`);
  };
  if (!(box.width > 0 && box.height > 0)) fail('is not visible');
  if (!(box.left >= -1)) fail(`starts off the left edge (${box.left})`);
  if (!(box.right <= width + 1)) fail(`runs past the right edge (${box.right} > ${width})`);
}

/** Move one finger from `from` to `to` in `steps`, the way a thumb moves. */
async function drag(page, from, to, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      ],
    });
    await delay(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** Swipe one finger from `fromY` to `toY`. */
async function swipe(page, x, fromY, toY, steps = 12) {
  await drag(page, { x, y: fromY }, { x, y: toY }, steps);
}

/** Swipe one finger sideways, from `fromX` to `toX`. */
async function swipeSideways(page, y, fromX, toX) {
  await drag(page, { x: fromX, y }, { x: toX, y });
}

/**
 * Rest one finger at `point`, without moving it, until `until` holds — what
 * the hold was for has happened — then lift it.
 */
async function hold(page, point, until, description) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  try {
    await waitForCondition(page, until, 10000, description);
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  }
}

/** The centre of a key on the key row. */
async function keyRowCentre(page, label) {
  return page.evaluate((l) => {
    const r = document.querySelector(`[data-key-row="${l}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, label);
}

/** A box on screen, or null. */
const boxOf = (page, selector) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  }, selector);

/**
 * Wait for the phone layout's 80-column grid to be the one on screen, with
 * the cell settled: two samples in a row agree on its width.
 */
async function waitForPhoneGrid(page) {
  let previous = null;
  await waitForCondition(
    page,
    async () => {
      const sample = await page.evaluate(() => {
        const c = window.app?.getSnapshot()?.context;
        const pane = document.querySelector('.pane-active [role="log"]');
        if (!c || !pane) return null;
        return {
          ok: c.phoneLayout === true && c.totalWidth === 80 && document.fonts.status === 'loaded',
          charWidth: c.charWidth,
        };
      });
      const settled = sample?.ok && previous?.charWidth === sample.charWidth;
      previous = sample;
      return settled;
    },
    20000,
    'the phone layout at 80 columns',
  );
}

module.exports = {
  PHONE,
  usePhoneContext,
  typeOnVirtualKeyboard,
  expectOnScreen,
  drag,
  swipe,
  swipeSideways,
  hold,
  keyRowCentre,
  boxOf,
  waitForPhoneGrid,
};
