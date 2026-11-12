/**
 * Keys typed while the page attaches: from the page's first frame until its
 * session arrives, nothing used to take them, and they were dropped. They
 * are held and sent the moment the session is there, in the order typed.
 */

const {
  describeE2E,
  waitForNotice,
  waitForShellPrompt,
  waitForTerminalText,
} = require('./helpers');

describeE2E('Scenario: keys typed during an attach arrive, in order', {}, (ctx) => {
  test('a command typed before the session arrives runs exactly as typed', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);

    // The stream is held back until the keys are in, so they certainly go
    // in while the page is still attaching (on a fast machine it opens
    // within a few milliseconds of the app, and the race would be luck).
    let held = 0;
    let release;
    const typed = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/events**', async (route) => {
      held++;
      await typed;
      await route.continue();
    });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => !!window.app, null, { timeout: 15000 });
    // No pane on screen yet: the session has not arrived.
    const attaching = await page.evaluate(() => window.app.view().activePaneId === null);

    // Typed at once, one key at a time, as fast as the keyboard sends them.
    // `$((…))` makes the output differ from the typed line, so the line
    // is found only if every key arrived, in order.
    await page.keyboard.type('echo early-$((6*7))-abcdefghij-0123456789');
    await page.keyboard.press('Enter');
    release();

    await waitForTerminalText(page, 'early-42-abcdefghij-0123456789', 15000);
    // The run was only a test of anything if the keys went in while attaching.
    expect(attaching).toBe(true);
    expect(held).toBeGreaterThan(0);
    await page.unroute('**/events**');
  }, 60000);

  /**
   * The first connection fails: what was typed meanwhile is dropped, and a
   * later connection never sends it (an Enter in it could run a command the
   * user has given up on). The user is told.
   */
  test('keys typed before a failed first connection never arrive', async () => {
    const { page } = ctx;
    await ctx.setupPage();
    await waitForShellPrompt(page);

    let attempts = 0;
    let release;
    const typed = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/events**', async (route) => {
      attempts++;
      if (attempts === 1) {
        await typed;
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });
    await page.reload({ waitUntil: 'commit' });
    await page.waitForFunction(() => !!window.app, null, { timeout: 15000 });
    await page.keyboard.type('echo given-up-$((6*7))');
    await page.keyboard.press('Enter');
    release();

    // A later connection succeeds; something typed after it arrives, and
    // nothing from before it ever does (it would have landed first).
    await page.waitForFunction(() => window.app.view().activePaneId !== null, null, {
      timeout: 30000,
    });
    await waitForShellPrompt(page);
    await page.keyboard.type('echo after-$((1+1))');
    await page.keyboard.press('Enter');
    await waitForTerminalText(page, 'after-2', 15000);
    const screen = await page.evaluate(
      () => document.querySelector('.pane-layout-item.pane-active [role="log"]')?.textContent ?? '',
    );
    expect(screen).not.toContain('given-up');
    await waitForNotice(page, 'typed before the connection failed were not sent');
    expect(attempts).toBeGreaterThan(1);
    await page.unroute('**/events**');
  }, 90000);
});
