/**
 * Nvim Rendering & Interaction E2E Tests
 *
 * One nvim boot covering rendering correctness, cursor shape changes
 * (DECSCUSR), typing round-trip and paging through a long file.
 */

const {
  createTestContext,
  delay,
  getTerminalText,
  waitForTerminalText,
  typeInTerminal,
  pressEnter,
  DELAYS,
} = require('./helpers');

const ctx = createTestContext();

beforeAll(ctx.beforeAll, ctx.hookTimeout);
afterAll(ctx.afterAll, ctx.hookTimeout);
beforeEach(ctx.beforeEach, ctx.hookTimeout);
afterEach(ctx.afterEach, ctx.hookTimeout);

// ==================== Helpers ====================

/**
 * Wait for a CSS class on the terminal cursor element.
 * @param {Page} page
 * @param {string} expectedClass - e.g. 'terminal-cursor-block' or 'terminal-cursor-bar'
 * @param {number} timeout
 */
async function waitForCursorClass(page, expectedClass, timeout = 10000) {
  const start = Date.now();
  // First ensure the cursor element exists at all
  let cursorFound = false;
  while (Date.now() - start < timeout) {
    const result = await page.evaluate((cls) => {
      const cursor = document.querySelector('.terminal-cursor');
      if (!cursor) return { exists: false, hasClass: false };
      return { exists: true, hasClass: cursor.classList.contains(cls) };
    }, expectedClass);
    if (result.exists) cursorFound = true;
    if (result.hasClass) return true;
    await delay(100);
  }
  const actual = await page.evaluate(() => {
    const cursor = document.querySelector('.terminal-cursor');
    return cursor ? cursor.className : 'no cursor element';
  });
  const hint = cursorFound ? '' : ' (cursor element never appeared in DOM)';
  throw new Error(
    `Timeout waiting for cursor class "${expectedClass}" (${timeout}ms). Actual: "${actual}"${hint}`,
  );
}

// ==================== Tests ====================

describe('Nvim Rendering & Interaction', () => {
  test('Scenario 6: nvim renders a long file, swaps cursor shape per mode, echoes typing and pages', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // A name of this run's own, so parallel runs never share a buffer.
    const file = `/tmp/nvim-e2e-${process.pid}-${Date.now()}.txt`;

    // A 500-line file with a unique prefix per line, long enough to page
    // through.
    await typeInTerminal(
      ctx.page,
      `seq 1 500 | awk '{printf "LINE%03d quick brown fox\\n", NR}' > ${file}`,
    );
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);

    // Open nvim with no swap file and minimal config
    await typeInTerminal(ctx.page, `nvim --clean -n ${file}`);
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'LINE001', 15000);

    // The rendered buffer occupies a visible area, not a clipped strip.
    const bufferBox = await ctx.page.evaluate(() => {
      const log = document.querySelector('[role="log"]');
      if (!log) return null;
      const r = log.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(bufferBox).not.toBeNull();
    expect(bufferBox.width).toBeGreaterThan(200);
    expect(bufferBox.height).toBeGreaterThan(100);

    // Verify normal mode: cursor should be block
    await waitForCursorClass(ctx.page, 'terminal-cursor-block');

    // Enter insert mode: 'A' appends at end of line, which does not depend on
    // where the cursor happens to sit.
    await ctx.page.keyboard.press('A');
    await delay(1500);

    // Typing round-trip: keystrokes → tmux → SSE → rendered DOM.
    const insertedText = 'jumps over the lazy dog';
    await ctx.page.keyboard.type(insertedText, { delay: 30 });
    await waitForTerminalText(ctx.page, 'lazy dog', 10000);

    // Verify insert mode: cursor should be bar (DECSCUSR 5)
    // nvim --clean sets guicursor to ver25 for insert mode
    await waitForCursorClass(ctx.page, 'terminal-cursor-bar');

    // Return to normal mode (Escape) — cursor is a block again
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.LONG);
    await waitForCursorClass(ctx.page, 'terminal-cursor-block');

    // Page down (Ctrl+D) out of the first screen
    for (let i = 0; i < 10; i++) {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('d');
      await ctx.page.keyboard.up('Control');
      await delay(200);
    }
    await delay(500);

    // Exact prefix so LINE001 doesn't match LINE100 and friends.
    const afterDown = await getTerminalText(ctx.page);
    expect(afterDown).not.toContain('LINE001');

    // Page up (Ctrl+U) back to the top
    for (let i = 0; i < 10; i++) {
      await ctx.page.keyboard.down('Control');
      await ctx.page.keyboard.press('u');
      await ctx.page.keyboard.up('Control');
      await delay(200);
    }
    await waitForTerminalText(ctx.page, 'LINE001', 5000);

    // Exit nvim discarding the edit (:q!) — use keyboard directly in normal mode
    await ctx.page.keyboard.type(':q!', { delay: 50 });
    await ctx.page.keyboard.press('Enter');
    await delay(2000);

    // Leaving the alternate screen restores the shell: the discarded edit is
    // gone from view.
    const text = await getTerminalText(ctx.page);
    expect(text).not.toContain(insertedText);

    await typeInTerminal(ctx.page, `rm -f ${file}`);
    await pressEnter(ctx.page);
  }, 120000);
});
