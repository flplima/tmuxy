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
 * (see describeE2E in helpers/e2e-context.js) instead of silently reporting green, and runs for real
 * anywhere the browser exists. `TMUXY_E2E_REQUIRE_WEBKIT=1` turns the skip
 * into a failure.
 */

const {
  runRect,
  shownRunRect,
  dragSelect,
  selectedText,
  selectionRect,
  recordCopies,
  copiedText,
  shownNotice,
  screenPixels,
} = require('./helpers/selection-drag');
const {
  waitForSettled,
  runCommand,
  typeInTerminal,
  typeComposedChar,
  pressEnter,
  getTerminalText,
  waitForCondition,
  describeE2E,
} = require('./helpers');

describeE2E(
  'WebKit: a selection survives every focus move that follows it',
  { browser: 'webkit' },
  (ctx) => {
    test('drag selects and copies, Cmd+C copies again and clears, and the context menu does not clear a fresh one', async () => {
      await ctx.setupPage();

      const TOKEN = 'WEBKIT_DRAG_ME';
      await runCommand(ctx.page, `echo "${TOKEN} and more"`, TOKEN);

      // 1. The drag. The pane wrapper is the grid's tab stop, so pressing in it
      //    moves browser focus — and the app used to hand the keyboard straight
      //    back to its hidden input, which on WebKit collapses the selection the
      //    drag is making. The result was a drag that selected nothing at all.
      const at = await runRect(ctx.page, '.pane-layout-item', TOKEN);
      expect(at).not.toBeNull();
      await recordCopies(ctx.page);
      // The blink lasts 450ms, less than a slow runner's poll: note each box
      // as it is added rather than looking for it afterwards.
      await ctx.page.evaluate(() => {
        window.__flashes = [];
        new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node.classList?.contains('copy-flash')) {
                const r = node.getBoundingClientRect();
                window.__flashes.push({
                  left: r.left,
                  top: r.top,
                  width: r.width,
                  height: r.height,
                });
              }
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      await dragSelect(ctx.page, at);
      expect(await selectedText(ctx.page)).toBe(TOKEN);

      // Selected text the user can see: the range paints over the run it covers.
      const painted = await selectionRect(ctx.page);
      expect(painted).not.toBeNull();
      expect(painted.height).toBeGreaterThan(4);
      expect(Math.abs(painted.left - at.box.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(painted.right - at.box.right)).toBeLessThanOrEqual(2);

      // 2. The focus move the pointer release triggers. Once the app has caught
      //    up with the release and painted, it has restored focus if it does;
      //    on WebKit a restore here is not a focus change, it is a lost selection.
      await waitForSettled(ctx.page);
      expect(await selectedText(ctx.page)).toBe(TOKEN);

      // 3. The release itself copied what was selected (copy on select). The
      //    copy EVENT is the assertion (the system clipboard needs a permission
      //    no headless browser grants). Selecting does not blink: the
      //    notification is the sign.
      await waitForCondition(
        ctx.page,
        async () => (await copiedText(ctx.page)) !== null,
        5000,
        'the release to fire a copy carrying the selected text',
      );
      expect(await copiedText(ctx.page)).toBe(TOKEN);
      expect(await ctx.page.evaluate(() => window.__flashes)).toHaveLength(0);
      expect(await selectedText(ctx.page)).toBe(TOKEN);

      // Cmd+C copies the same text once more and, as the next key, clears the
      // highlight; the text stays on the clipboard. A fresh drag selects again.
      await ctx.page.evaluate(() => {
        window.__copied = null;
      });
      await ctx.page.keyboard.press('Meta+c');
      await waitForCondition(
        ctx.page,
        async () => (await copiedText(ctx.page)) === TOKEN,
        5000,
        'Cmd+C to copy the selected text again',
      );
      // A copy key is a deliberate copy: it blinks the text it took, where it is.
      const flash = await ctx.page.evaluate(() => window.__flashes);
      expect(flash.length).toBeGreaterThan(0);
      expect(flash[0].width).toBeGreaterThan(0);
      expect(flash[0].height).toBeGreaterThan(0);
      expect(Math.abs(flash[0].left - at.box.left)).toBeLessThanOrEqual(2);
      // On the word's row: the blink's middle inside the row's box. Its top is
      // the text's, which a WebKit build's font metrics can put a pixel or
      // three from the row's own top (2.5 on the 26.04 build).
      const middle = flash[0].top + flash[0].height / 2;
      expect(middle).toBeGreaterThan(at.box.top);
      expect(middle).toBeLessThan(at.box.bottom);
      expect(await selectedText(ctx.page)).toBe('');
      await dragSelect(ctx.page, at);
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
      await shownNotice(ctx.page, `Copied ${TOKEN.length} characters`);

      // The terminal still works after all that focus traffic.
      await ctx.page.evaluate(() => window.getSelection().removeAllRanges());
      await runCommand(ctx.page, 'echo WEBKIT_STILL_ALIVE', 'WEBKIT_STILL_ALIVE');
    }, 180000);

    /**
     * WebKit blends an OPAQUE `::selection` background with white into a
     * translucent colour, so over a dark pane selected text sat on near-black
     * while the fill past the row's end (a plain background) showed the grey
     * asked for. And WebKit paints a selection only as high as the text, so a
     * selected cell's own background showed as thin bands above and below it,
     * and selected rows had gaps between them. Chromium paints both alike; the
     * computed styles agree in both engines. Only the pixels tell.
     */
    test('selected text sits on the same grey as the fill past the end of its row, edge to edge', async () => {
      await ctx.setupPage();

      // WKPIX_TWO on a green background of its own.
      const ONE = 'WKPIX_ONE WKPIX_TWO';
      const END = 'WKPIX_END';
      await runCommand(
        ctx.page,
        `printf '%s \\033[42m%s\\033[0m\\n%s\\n' WKPIX_ONE WKPIX_TWO '${END}'`,
        END,
      );
      const one = await shownRunRect(ctx.page, '.pane-layout-item', ONE);
      const end = await shownRunRect(ctx.page, '.pane-layout-item', END);
      expect(end.y).toBeGreaterThan(one.y);

      // From the first row into the next: the first row is selected from its
      // first cell to the pane's edge, its blanks by the row's fill.
      await dragSelect(ctx.page, one, end);
      // The browser's own string breaks the line between the two runs.
      expect(await selectedText(ctx.page)).toMatch(/WKPIX_ONE\s+WKPIX_TWO\s+WKPIX_END/);
      let row = null;
      await waitForCondition(
        ctx.page,
        async () => {
          row = await ctx.page.evaluate((needle) => {
            const line = [...document.querySelectorAll('.pane-layout-item .terminal-line')]
              .filter((l) => (l.textContent || '').includes(needle))
              .pop();
            if (!line) return null;
            const r = line.getBoundingClientRect();
            const after = getComputedStyle(line, '::after');
            return {
              filled: after.content !== 'none' && parseFloat(after.width) > 0,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              cellW: parseFloat(getComputedStyle(line).getPropertyValue('--cell-w')),
            };
          }, ONE);
          return row?.filled === true;
        },
        5000,
        () => `the first row to be filled past its end (${JSON.stringify(row)})`,
      );

      // The space between the two words: a selected cell with no glyph on it.
      // The fill: a few pixels in from the row's right edge. The pane's own
      // background: the same spot on the row below the selection's last.
      // The green cell's top and bottom pixel rows, and the seam between the
      // two selected rows (the first row's last pixel row over its first
      // cell, the next row's first over END's), where no glyph reaches.
      const space = ONE.indexOf(' ');
      const green = one.box.left + (ONE.indexOf('TWO') + 0.5) * row.cellW;
      const [underText, pastEnd, unselected, greenTop, greenBottom, seamAbove, seamBelow] =
        await screenPixels(ctx.page, [
          { x: one.box.left + (space + 0.5) * row.cellW, y: one.y },
          { x: row.right - row.cellW / 2, y: one.y },
          { x: row.right - row.cellW / 2, y: end.y + (row.bottom - row.top) },
          { x: green, y: row.top + 0.5 },
          { x: green, y: row.bottom - 1 },
          { x: one.box.left + row.cellW / 2, y: row.bottom - 1 },
          { x: end.box.left + row.cellW / 2, y: row.bottom + 0.5 },
        ]);
      const apartBy = (a, b) =>
        Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
      const near = (a, b) => apartBy(a, b) <= 3;
      expect({ underText, pastEnd, same: near(underText, pastEnd) }).toEqual({
        underText,
        pastEnd,
        same: true,
      });
      // The selection is the row's full height: the grey reaches its edges,
      // over the green cell too (a 99% grey lets 1% of the green through).
      const edges = { greenTop, greenBottom, seamAbove, seamBelow };
      const offGrey = Object.fromEntries(
        Object.entries(edges).map(([at, px]) => [at, apartBy(px, pastEnd)]),
      );
      expect({
        pastEnd,
        edges,
        offGrey,
        under: Object.values(offGrey).every((d) => d <= 6),
      }).toEqual({ pastEnd, edges, offGrey, under: true });
      // …and it is a selection anyone can see: not the pane's background.
      const apart = Math.max(
        Math.abs(pastEnd.r - unselected.r),
        Math.abs(pastEnd.g - unselected.g),
        Math.abs(pastEnd.b - unselected.b),
      );
      expect(apart).toBeGreaterThan(40);

      await ctx.page.evaluate(() => window.getSelection().removeAllRanges());
    }, 120000);
  },
);

describeE2E(
  'WebKit: accented characters survive a click into the pane',
  { browser: 'webkit' },
  (ctx) => {
    test('a click gives the keyboard back, and composed characters reach the shell', async () => {
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
      await waitForCondition(
        ctx.page,
        async () =>
          (await getTerminalText(ctx.page)).replace(/\s+/g, '').split(expected).length - 1 >= 2,
        20000,
        'the composed text to be on screen twice: typed, then echoed',
      );
    }, 180000);
  },
);
