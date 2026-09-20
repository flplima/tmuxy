/**
 * WebKit: selection, copy and focus
 *
 * Everything else in this suite runs on Chromium, and the one WebKit suite
 * that exists (tests/tauri/) is Linux/WebKitGTK only — so the engine the macOS
 * desktop app actually ships on, WKWebView, is covered by nothing functional.
 * Playwright's WebKit is the cheap proxy for it.
 *
 * The difference that matters is one sentence long: **WebKit collapses the
 * document's selection whenever focus moves, and Blink does not.** Every
 * selection bug this project has shipped to the desktop came from that —
 * a right-click menu that cleared the text it was about, a pane handing the
 * keyboard back mid-drag and selecting nothing, an accent lost because focus
 * was NOT handed back. Chromium passes all of them.
 *
 * This suite cannot run where WebKit is not installed, and docs/TESTS.md
 * forbids installing Playwright browsers locally. It therefore skips LOUDLY
 * (see own-browser.js) instead of silently reporting green, and runs for real
 * anywhere the browser exists. `TMUXY_E2E_REQUIRE_WEBKIT=1` turns the skip
 * into a failure.
 */

const { webkit } = require('playwright');
const { createOwnBrowserContext } = require('./helpers/own-browser');
const { runRect, dragSelect, selectedText, selectionRect } = require('./helpers/selection-drag');
const {
  runCommand,
  typeInTerminal,
  typeComposedChar,
  pressEnter,
  getTerminalText,
  waitForCondition,
  delay,
  DELAYS,
} = require('./helpers');

function webkitContext() {
  return createOwnBrowserContext({
    label: 'Playwright WebKit',
    optional: true,
    requireEnv: 'TMUXY_E2E_REQUIRE_WEBKIT',
    openBrowser: () => webkit.launch({ headless: true }),
    contextOptions: { viewport: { width: 1280, height: 720 } },
  });
}

describe('WebKit: a selection survives every focus move that follows it', () => {
  const ctx = webkitContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('drag selects, Cmd+C copies it, and the context menu does not clear it', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();

    const TOKEN = 'WEBKIT_DRAG_ME';
    await runCommand(ctx.page, `echo "${TOKEN} and more"`, TOKEN);

    // 1. The drag. The pane wrapper is the grid's tab stop, so pressing in it
    //    moves browser focus — and the app used to hand the keyboard straight
    //    back to its hidden input, which on WebKit collapses the selection the
    //    drag is making. The result was a drag that selected nothing at all.
    const at = await runRect(ctx.page, '.pane-layout-item', TOKEN);
    expect(at).not.toBeNull();
    await dragSelect(ctx.page, at);
    expect(await selectedText(ctx.page)).toBe(TOKEN);

    // Selected text the user can see: the range paints over the run it covers.
    const painted = await selectionRect(ctx.page);
    expect(painted).not.toBeNull();
    expect(painted.height).toBeGreaterThan(4);
    expect(Math.abs(painted.left - at.box.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(painted.right - at.box.right)).toBeLessThanOrEqual(2);

    // 2. The focus move the pointer release triggers. Give the app the frames
    //    it would use to restore focus, then look again: on WebKit a restore
    //    here is not a focus change, it is a lost selection.
    await delay(DELAYS.LONG);
    expect(await selectedText(ctx.page)).toBe(TOKEN);

    // 3. Cmd+C copies what is selected, and copying does not take it away.
    //    The copy EVENT is the assertion (the system clipboard needs a
    //    permission no headless browser grants), plus the blink the user sees.
    await ctx.page.evaluate(() => {
      window.__copied = null;
      window.addEventListener('copy', (e) => {
        window.__copied = e.clipboardData.getData('text/plain');
      });
    });
    await ctx.page.keyboard.press('Meta+c');
    await waitForCondition(
      ctx.page,
      async () => (await ctx.page.evaluate(() => window.__copied)) !== null,
      5000,
      'Cmd+C to fire a copy carrying the selected text',
    );
    expect(await ctx.page.evaluate(() => window.__copied)).toBe(TOKEN);
    const flash = await ctx.page.evaluate(() =>
      [...document.querySelectorAll('.copy-flash')].map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      }),
    );
    expect(flash.length).toBeGreaterThan(0);
    expect(flash[0].width).toBeGreaterThan(0);
    expect(flash[0].height).toBeGreaterThan(0);
    expect(Math.abs(flash[0].left - at.box.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(flash[0].top - at.box.top)).toBeLessThanOrEqual(2);
    expect(await selectedText(ctx.page)).toBe(TOKEN);

    // 4. The escaped bug itself: right-clicking a selection opens a menu, the
    //    menu takes focus, and on WebKit the text the menu is about vanished
    //    under it. The selection has to still be there — and still be painted
    //    over the same run — while the menu is up.
    await ctx.page.mouse.click((at.box.left + at.box.right) / 2, at.y, { button: 'right' });
    const copyItem = ctx.page.locator('[role="menuitem"]', { hasText: 'Copy' }).first();
    await copyItem.waitFor({ state: 'visible', timeout: 10000 });
    const itemBox = await copyItem.boundingBox();
    expect(itemBox).not.toBeNull();
    expect(itemBox.width).toBeGreaterThan(20);
    expect(itemBox.height).toBeGreaterThan(8);

    const underMenu = await selectionRect(ctx.page);
    expect(underMenu).not.toBeNull();
    expect(underMenu.height).toBeGreaterThan(4);
    expect(Math.abs(underMenu.left - at.box.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(underMenu.right - at.box.right)).toBeLessThanOrEqual(2);

    // 5. …and the menu copies that text, not the empty string a collapsed
    //    selection would have handed it.
    await copyItem.click();
    await waitForCondition(
      ctx.page,
      async () =>
        (await ctx.page.evaluate(() => window.__tmuxyLastClipboard?.text ?? null)) !== null,
      5000,
      'the menu to copy the selected text',
    );
    expect(await ctx.page.evaluate(() => window.__tmuxyLastClipboard.text)).toBe(TOKEN);

    // The terminal still works after all that focus traffic.
    await ctx.page.evaluate(() => window.getSelection().removeAllRanges());
    await runCommand(ctx.page, 'echo WEBKIT_STILL_ALIVE', 'WEBKIT_STILL_ALIVE');
  }, 180000);
});

describe('WebKit: accented characters survive a click into the pane', () => {
  const ctx = webkitContext();
  beforeAll(ctx.beforeAll, ctx.hookTimeout);
  afterAll(ctx.afterAll, ctx.hookTimeout);
  beforeEach(ctx.beforeEach, ctx.hookTimeout);
  afterEach(ctx.afterEach, ctx.hookTimeout);

  test('a click gives the keyboard back, and composed characters reach the shell', async () => {
    if (ctx.skipIfUnavailable()) return;
    await ctx.setupPage();

    // Click into the pane the way a user does. The wrapper is focusable, so
    // the click lands browser focus on a plain div — and a dead key is not a
    // keystroke the browser reports: the OS composes ´ + a into á and delivers
    // it only to what is being EDITED. With focus parked on the div there is
    // nowhere for the composed character to go, which is why this reads as
    // "accents stopped working" rather than "typing stopped working".
    const pane = await ctx.page.$('.pane-active [role="log"]');
    expect(pane).not.toBeNull();
    await pane.click();
    await waitForCondition(
      ctx.page,
      async () =>
        ctx.page.evaluate(() => {
          const el = document.activeElement;
          return !!el && el.tagName === 'INPUT';
        }),
      5000,
      'the pane to hand the keyboard back to the editable element',
    );

    // Now type through the paths a LAYOUT composes with: a dead key, and
    // macOS Option — the two that produce an accent on the machines this
    // engine ships to.
    const marker = `WKINTL${Date.now()}`;
    const payload = 'áéõç';
    await typeInTerminal(ctx.page, `echo ${marker}`);
    for (const ch of 'áéõ') await typeComposedChar(ctx.page, ch, 'dead');
    await typeComposedChar(ctx.page, 'ç', 'option');
    await pressEnter(ctx.page);

    // Echoed by the shell, so this is what the PROGRAM received through real
    // tmux: twice — the command line, then echo's output.
    const expected = `${marker}${payload}`;
    const deadline = Date.now() + 20000;
    let occurrences = 0;
    while (Date.now() < deadline) {
      const text = (await getTerminalText(ctx.page)).replace(/\s+/g, '');
      occurrences = text.split(expected).length - 1;
      if (occurrences >= 2) break;
      await delay(DELAYS.SHORT);
    }
    expect(occurrences).toBeGreaterThanOrEqual(2);
  }, 180000);
});
