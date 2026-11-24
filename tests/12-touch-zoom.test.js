/**
 * The phone's zoom, finger only, with the keyboard up and down.
 *
 * Zoomed by a double tap, the terminal is drawn at twice its size.
 * Upright, the bar under the keys moves down to match and the bottom view
 * gives up the room, so every row is on screen and the view scrolls sideways
 * only, with the key row under it. Held sideways, the
 * doubled grid is taller than the screen and scrolls both ways. Either way a
 * keyboard coming up cuts the terminal short, and it scrolls to keep the
 * cursor's row in view above the keyboard (components/phone/usePhoneViewport.ts).
 *
 * A headless browser draws no keyboard and never shrinks its visual viewport,
 * so the suite brings up a mock one that does both (helpers/keyboard-mock.js).
 * Every assertion is about boxes on screen.
 */

const {
  PHONE,
  phoneContext,
  typeOnVirtualKeyboard,
  keyRowCentre,
  doubleTapTerminal,
  pinch,
  swipe,
  boxOf,
  waitForPhoneGrid,
} = require('./helpers/phone');
const { showKeyboard, hideKeyboard } = require('./helpers/keyboard-mock');
const {
  describeE2E,
  waitForCondition,
  waitForTerminalText,
  waitForCopyMode,
  getCopyModeState,
} = require('./helpers');

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

/** Double tap the terminal and wait for the zoom to be on (or off). */
async function toggleZoom(page, on) {
  await doubleTapTerminal(page);
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

describeE2E(
  'Phone upright (390x844): the zoom shows every row, and the keyboard keeps the cursor in view',
  { context: phoneContext(PHONE) },
  (ctx) => {
    test('zoom → the bar moves down and the bottom view gives the room, every row on screen at twice its size, sideways scroll only → keyboard up → the cursor row stays above it → zoom off', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);
      const before = await boxOf(ctx.page, '.phone-pty .pane-container');
      const barBefore = await boxOf(ctx.page, '[data-testid="phone-divider"]');

      await toggleZoom(ctx.page, true);
      const zoomed = await ctx.page.evaluate(() => {
        const box = (el) => el.getBoundingClientRect().toJSON();
        const viewport = document.querySelector('.phone-zoom-viewport');
        const term = document.querySelector('.phone-pty');
        const lines = [...document.querySelectorAll('.phone-pty .pane-active .terminal-line')];
        return {
          bar: box(document.querySelector('[data-testid="phone-divider"]')),
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
      // The bar follows the zoom: down by the room the terminal took.
      expect(zoomed.bar.top).toBeGreaterThan(barBefore.top + before.height * 0.9);
      expect(zoomed.bar.top).toBeGreaterThanOrEqual(zoomed.keys.bottom - 0.5);
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
      expect((await boxOf(ctx.page, '[data-testid="phone-divider"]')).top).toBeCloseTo(
        barBefore.top,
        0,
      );
    }, 120000);

    // The browser's own zoom, which the app's double tap is not: the page's
    // pinch. A touch the app claims (a preventDefault) is one the browser
    // cannot pinch with, so the page zoomed in and could not zoom back out.
    test("two fingers are the browser's pinch, in and back out, on the terminal and on the bottom view: the app claims none of it, and one finger still scrolls", async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);

      // History, so a finger dragged down on the pane would open the scroll view.
      await keyboardUp(ctx.page, 300);
      await typeOnVirtualKeyboard(ctx.page, 'for i in $(seq 0 79); do echo "line-$i"; done\n');
      await waitForTerminalText(ctx.page, 'line-79', 20000);
      await hideKeyboard(ctx.page);
      const key = await keyRowCentre(ctx.page, '⌨');
      await ctx.page.touchscreen.tap(key.x, key.y);
      const tab = await ctx.page.evaluate(() => window.app.view().activeTabId);

      // Every touch event with two fingers in it, and how many of them a
      // handler on the way up (the pane's, the view's) took from the browser.
      await ctx.page.evaluate(() => {
        window.__twoFingers = { seen: 0, prevented: 0 };
        for (const type of ['touchstart', 'touchmove', 'touchend']) {
          window.addEventListener(type, (e) => {
            if (e.touches.length + (type === 'touchend' ? e.changedTouches.length : 0) < 2) return;
            window.__twoFingers.seen += 1;
            if (e.defaultPrevented) window.__twoFingers.prevented += 1;
          });
        }
      });
      const twoFingers = () => ctx.page.evaluate(() => window.__twoFingers);

      // The page's zoom, as the browser draws it.
      const scale = () => ctx.page.evaluate(() => window.visualViewport.scale);
      const zoomTo = (zoomedIn, where) =>
        waitForCondition(
          ctx.page,
          async () => (await scale()) > 1.2 === zoomedIn,
          5000,
          async () =>
            `a pinch on ${where} to zoom the page ${zoomedIn ? 'in' : 'back out'} (scale ${await scale()})`,
        );

      // On the bottom view, the fingers sideways, as its slide between views goes.
      const bottom = await boxOf(ctx.page, '.phone-bottom-stage');
      const y = bottom.top + bottom.height / 2;
      const along = (f) => bottom.left + bottom.width * f;
      const near = [
        { x: along(0.45), y },
        { x: along(0.55), y },
      ];
      const far = [
        { x: along(0.1), y },
        { x: along(0.9), y },
      ];
      // Whether the pane takes a finger landing on it from the browser (the
      // hold's guard against the long press): on iOS a first finger taken so
      // takes the whole gesture, and a pinch on the terminal never zoomed back out.
      const paneTakesFinger = () =>
        ctx.page.evaluate(() => {
          const wrapper = document.querySelector('.pane-active .pane-wrapper');
          const r = wrapper.getBoundingClientRect();
          const touch = new Touch({
            identifier: 99,
            target: wrapper,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
          });
          const down = new TouchEvent('touchstart', {
            touches: [touch],
            targetTouches: [touch],
            changedTouches: [touch],
            bubbles: true,
            cancelable: true,
          });
          wrapper.dispatchEvent(down);
          const up = new TouchEvent('touchcancel', { changedTouches: [touch], bubbles: true });
          wrapper.dispatchEvent(up);
          return down.defaultPrevented;
        });
      expect(await paneTakesFinger()).toBe(true);
      await pinch(ctx.page, near, far);
      await zoomTo(true, 'the bottom view');
      expect(await paneTakesFinger()).toBe(false);
      await pinch(ctx.page, far, near);
      await zoomTo(false, 'the bottom view');
      expect(await paneTakesFinger()).toBe(true);
      // On the terminal, a pinch in slower than a hold, its first finger the
      // upper one coming down, as the finger that opens the scroll view does.
      const pane = await boxOf(ctx.page, '.pane-active [role="log"]');
      const x = pane.left + pane.width / 2;
      const across = (f) => pane.top + pane.height * f;
      await pinch(
        ctx.page,
        [
          { x, y: across(0.2) },
          { x, y: across(0.8) },
        ],
        [
          { x, y: across(0.45) },
          { x, y: across(0.55) },
        ],
        48,
      );

      // None of it was the app's: no handler took a two-finger touch from
      // the browser, no hold, scroll view or tab slide began.
      const seen = await twoFingers();
      expect(seen.seen).toBeGreaterThan(40);
      expect(seen.prevented).toBe(0);
      expect(await getCopyModeState(ctx.page)).toBeNull();
      expect(await ctx.page.evaluate(() => window.app.view().activeTabId)).toBe(tab);
      // The terminal lets the browser pinch, as `touch-action` tells it
      // before any handler runs. (Chromium also drops a pinch whose first
      // finger's touchstart was taken — the hold's guard against the long
      // press — so the zoom itself is asserted on the bottom view.)
      expect(
        await ctx.page.evaluate(
          () => getComputedStyle(document.querySelector('.pane-active .pane-wrapper')).touchAction,
        ),
      ).toBe('pinch-zoom');

      // One finger is still the app's: dragged down, it opens the scroll view.
      await swipe(ctx.page, x, pane.top + pane.height * 0.25, pane.top + pane.height * 0.85);
      expect((await waitForCopyMode(ctx.page, true, 15000)).mode).toBe('scroll');
    }, 120000);
  },
);

describeE2E(
  'Phone sideways (844x390): zoomed, the keyboard keeps the cursor in view',
  { context: phoneContext(SIDEWAYS) },
  (ctx) => {
    test('zoom → the doubled grid scrolls both ways between the tree and the side pane → keyboard up → the cursor row stays above it', async () => {
      await ctx.setupPage();
      await waitForPhoneGrid(ctx.page);

      await toggleZoom(ctx.page, true);
      const zoomed = await ctx.page.evaluate(() => {
        const viewport = document.querySelector('.phone-zoom-viewport');
        const term = document.querySelector('.phone-pty');
        return {
          sideways: viewport.scrollWidth - viewport.clientWidth,
          upright: term.scrollHeight - term.clientHeight,
          tree: document.querySelector('.phone-side-left .phone-tree')?.getBoundingClientRect()
            .width,
          side: document.querySelector('.phone-side-right')?.getBoundingClientRect().width,
        };
      });
      expect(zoomed.sideways).toBeGreaterThan(10);
      expect(zoomed.upright).toBeGreaterThan(10);
      expect(zoomed.tree).toBeGreaterThan(0);
      expect(zoomed.side).toBeGreaterThan(0);

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
  },
);
