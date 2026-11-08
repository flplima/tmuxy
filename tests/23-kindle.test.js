/**
 * The e-ink page: `/?kindle` leaves the app for `kindle.html`, a minimal
 * client for a browser too old for the app (the Kindle Scribe's Silk, Chrome
 * 80). Everything here goes through the page's own controls: the text box and
 * Send, the key buttons, a tap on a pane, the tab buttons. What is checked is
 * what the screen shows, in a box the viewport actually holds.
 */

const { describeE2E, waitForCondition, TMUXY_URL, TMUXY_CLI } = require('./helpers');

/** The screen's rows, as drawn. */
const screenRows = (page) =>
  page.evaluate(() => document.querySelector('.kindle-screen').innerText.split('\n'));

/** The rows that contain `text`, once at least one does. */
async function waitForRow(page, text, description = `"${text}" on the screen`) {
  return waitForCondition(
    page,
    async () => {
      const rows = (await screenRows(page)).filter((row) => row.includes(text));
      return rows.length > 0 ? rows : null;
    },
    10000,
    description,
  );
}

/** Type a line into the page's text box and send it, Enter included. */
async function sendLine(page, text) {
  await page.fill('.kindle-text', text);
  await page.click('.kindle-send');
}

describeE2E('Scenario: the e-ink page at /?kindle', {}, (ctx) => {
  test('opens from ?kindle, runs what is typed, splits, follows a tapped pane, interrupts with ^C, switches tabs', async () => {
    const { page } = ctx;
    await page.setViewportSize({ width: 744, height: 992 });
    await page.goto(`${TMUXY_URL}/?kindle&session=${encodeURIComponent(ctx.session.name)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForURL(/\/kindle\.html\?kindle/);

    // The screen fills the space between the bars, inside the viewport.
    const screen = await page.locator('.kindle-screen').boundingBox();
    expect(screen.width).toBeGreaterThan(600);
    expect(screen.height).toBeGreaterThan(400);
    expect(screen.y + screen.height).toBeLessThanOrEqual(992);

    // The keys go to the pane the page has drawn, so wait for its first frame.
    await waitForCondition(
      page,
      async () => (await screenRows(page)).some((row) => row.trim() !== ''),
      10000,
      'the pane drawn',
    );
    // Each marker is computed by the shell, so the typed line cannot match it.
    await sendLine(page, 'echo kindle-$((6*7))');
    await waitForRow(page, 'kindle-42');

    // A split shows both panes, a divider between them.
    await sendLine(page, `clear; ${TMUXY_CLI} pane split -h`);
    await waitForRow(page, '│', 'a divider between two panes');
    const rect = await page.locator('.kindle-screen').boundingBox();

    // The new pane has the keyboard; a tap on the left one takes it there.
    await page.mouse.click(rect.x + rect.width * 0.2, rect.y + rect.height * 0.5);
    await sendLine(page, 'echo left-$((2+3))');
    const leftRows = await waitForRow(page, 'left-5');
    expect(leftRows.some((row) => row.indexOf('left-5') < row.indexOf('│'))).toBe(true);

    // ^C ends what runs in the pane: without it the next line waits 30s.
    await sendLine(page, 'sleep 30');
    await waitForRow(page, 'sleep 30');
    await page.click('.kindle-key[data-key="C-c"]');
    await sendLine(page, 'echo after-$((3*3))');
    await waitForRow(page, 'after-9', 'the shell free again after ^C');

    // A second tab gets a button; the buttons move between the tabs.
    await sendLine(page, `${TMUXY_CLI} tab create kindle-two`);
    await page.locator('.kindle-tab.active', { hasText: 'kindle-two' }).waitFor();
    await sendLine(page, 'echo second-$((1+1))');
    await waitForRow(page, 'second-2');
    await page.locator('.kindle-tab').first().click();
    await waitForCondition(
      page,
      async () => {
        const rows = (await screenRows(page)).join('\n');
        return rows.includes('left-5') && !rows.includes('second-2');
      },
      10000,
      'the first tab back on the screen',
    );
    const firstTab = page.locator('.kindle-tab').first();
    await expect(firstTab.getAttribute('class')).resolves.toContain('active');
  });
});
