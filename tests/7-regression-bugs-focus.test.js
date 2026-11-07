/**
 * Regression Tests for Production Bugs (typing before any click)
 *
 * Giving the page the focus — loading it, switching back to its tab — and
 * typing did nothing until a pane was clicked: the browser restores whatever
 * element it last had, and a keystroke from there was typed into nothing.
 * The app now takes the keyboard for the active pane whenever the page gets
 * the focus, so what is typed lands at once.
 */

const { describeE2E, openSession, waitForTerminalText, waitForCondition } = require('./helpers');

const typeLine = async (page, text) => {
  await page.keyboard.type(text, { delay: 10 });
  await page.keyboard.press('Enter');
};

/** The marker's line, drawn where the user can read it. */
const visibleLineWith = (page, marker) =>
  page.evaluate((m) => {
    const line = [...document.querySelectorAll('.pane-active .terminal-line')].find(
      (l) => l.textContent.trim() === m,
    );
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { width: r.width, height: r.height, top: r.top };
  }, marker);

const expectTyped = async (page, marker) => {
  await waitForTerminalText(page, marker, 15000, { notOnLineWith: 'echo' });
  const rect = await visibleLineWith(page, marker);
  expect(rect).not.toBeNull();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
};

const holdsKeyboard = (page) =>
  page.evaluate(() => document.activeElement?.dataset?.keyboardTarget !== undefined);

describeE2E(
  'Scenario: typing reaches the active pane as soon as the page has the focus',
  {},
  (ctx) => {
    test('a fresh load, a tab switch with the focus left on a chrome control, and a focus restored to the body: no click, the text lands', async () => {
      await ctx.setupPage();
      const page = ctx.page;

      // 1. Loaded again, never clicked.
      await openSession(page, ctx.session.name);
      await waitForCondition(
        page,
        () => holdsKeyboard(page),
        10000,
        'the app to hold the keyboard',
      );
      await typeLine(page, 'echo FOCUS_LOAD_OK');
      await expectTyped(page, 'FOCUS_LOAD_OK');

      // 2. The focus on a chrome control (as a restore may leave it), then the
      //    page focused again, as a switch back to its tab does. A headless
      //    Chrome keeps every tab visible and focused, so the window event is
      //    dispatched as the browser would on a real switch.
      await page.evaluate(() => {
        document.querySelector('.app-menu-button').focus();
        window.dispatchEvent(new Event('focus'));
      });
      await waitForCondition(
        page,
        () => holdsKeyboard(page),
        10000,
        'the keyboard back after a tab switch',
      );
      await typeLine(page, 'echo FOCUS_TAB_OK');
      await expectTyped(page, 'FOCUS_TAB_OK');

      // 3. The focus dropped to the body, then the page focused again.
      await page.evaluate(() => {
        document.activeElement?.blur();
        window.dispatchEvent(new Event('focus'));
      });
      await waitForCondition(
        page,
        () => holdsKeyboard(page),
        10000,
        'the keyboard back from the body',
      );
      await typeLine(page, 'echo FOCUS_BODY_OK');
      await expectTyped(page, 'FOCUS_BODY_OK');
    }, 120000);

    test('a desktop whose screen also takes touch: a fresh load, no click, the text lands', async () => {
      await ctx.setupPage();
      const page = ctx.page;

      // A touchscreen laptop, or a desktop with a touch display or a pen: the
      // browser reports touch points, but the mouse is the primary pointer and
      // the page is laid out for it. Only a phone or tablet keeps the keyboard
      // down until a tap asks for it.
      await page.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 10 });
      });
      await openSession(page, ctx.session.name);
      expect(await page.evaluate(() => navigator.maxTouchPoints)).toBe(10);
      expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
      await waitForCondition(
        page,
        () => holdsKeyboard(page),
        10000,
        'the app to hold the keyboard',
      );
      await typeLine(page, 'echo FOCUS_TOUCH_DESKTOP_OK');
      await expectTyped(page, 'FOCUS_TOUCH_DESKTOP_OK');
    }, 120000);
  },
);
