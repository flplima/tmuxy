/**
 * A phone in a test: its own touch-enabled Chromium context at a phone's
 * viewport, the virtual keyboard, and the check that a box is on screen.
 * Shared by the touch suites (tests/12-touch*.test.js).
 */

const { createOwnBrowserContext } = require('./own-browser');
const { getBrowser, delay } = require('./browser');

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

module.exports = { PHONE, usePhoneContext, typeOnVirtualKeyboard, expectOnScreen };
