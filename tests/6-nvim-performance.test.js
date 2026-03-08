/**
 * Nvim Performance & Correctness E2E Tests
 *
 * Tests nvim rendering correctness, typing performance, scroll performance,
 * and cursor shape changes (DECSCUSR).
 */

const {
  createTestContext,
  delay,
  getTerminalText,
  waitForTerminalText,
  typeInTerminal,
  pressEnter,
  DELAYS,
  measureTime,
  typeWithTiming,
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
  while (Date.now() - start < timeout) {
    const hasClass = await page.evaluate((cls) => {
      const cursor = document.querySelector('.terminal-cursor');
      return cursor ? cursor.classList.contains(cls) : false;
    }, expectedClass);
    if (hasClass) return true;
    await delay(100);
  }
  const actual = await page.evaluate(() => {
    const cursor = document.querySelector('.terminal-cursor');
    return cursor ? cursor.className : 'no cursor element';
  });
  throw new Error(
    `Timeout waiting for cursor class "${expectedClass}" (${timeout}ms). Actual: "${actual}"`,
  );
}

// ==================== Tests ====================

describe('Nvim Performance & Correctness', () => {
  test('Scenario 6a: Nvim rendering correctness and cursor shape', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create a test file with unique content
    const fileContent = 'NVIM_TEST_CONTENT_ABC123';
    await typeInTerminal(ctx.page, `echo "${fileContent}" > /tmp/nvim-test.txt`);
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);

    // Open nvim with no swap file and minimal config
    await typeInTerminal(ctx.page, 'nvim --clean -n /tmp/nvim-test.txt');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, fileContent, 15000);

    // Verify normal mode: cursor should be block
    await waitForCursorClass(ctx.page, 'terminal-cursor-block');

    // Enter insert mode: type 'A' to append text (uses 'A' which is more reliable
    // than 'i' since it doesn't depend on cursor position)
    await ctx.page.keyboard.press('A');
    await delay(1500);

    // Type some text to verify we're in insert mode
    const insertedText = 'AAABBBCCC';
    for (const ch of insertedText) {
      await ctx.page.keyboard.type(ch);
      await delay(50);
    }
    await waitForTerminalText(ctx.page, insertedText, 10000);

    // Verify insert mode: cursor should be bar (DECSCUSR 5)
    // nvim --clean sets guicursor to ver25 for insert mode
    await waitForCursorClass(ctx.page, 'terminal-cursor-bar');

    // Return to normal mode (Escape)
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.LONG);

    // Verify cursor is back to block
    await waitForCursorClass(ctx.page, 'terminal-cursor-block');

    // Exit nvim (:q!) — use keyboard directly in normal mode
    await ctx.page.keyboard.type(':q!', { delay: 50 });
    await ctx.page.keyboard.press('Enter');
    await delay(2000);

    // After exiting nvim, the terminal leaves alternate screen mode.
    // Verify the inserted text is no longer visible (nvim discarded changes).
    const text = await getTerminalText(ctx.page);
    expect(text).not.toContain(insertedText);
  }, 60000);

  test('Scenario 6b: Nvim typing performance', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create a test file and open it in nvim with minimal config
    await typeInTerminal(ctx.page, 'nvim --clean -n /tmp/nvim-perf.txt');
    await pressEnter(ctx.page);
    await delay(3000); // Wait for nvim to fully load

    // Enter insert mode
    await ctx.page.keyboard.press('i');
    await delay(DELAYS.LONG);

    // Type a paragraph and measure time for it to appear
    const paragraph = 'The quick brown fox jumps over the lazy dog. Performance testing in progress.';
    const typeTime = await typeWithTiming(ctx.page, paragraph);

    // Wait for the text to appear in the terminal
    await waitForTerminalText(ctx.page, 'lazy dog', 10000);

    // Generous threshold: typing + round-trip should complete within 5s
    expect(typeTime).toBeLessThan(5000);

    // Exit nvim
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.type(':q!', { delay: 50 });
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.LONG);
  }, 60000);

  test('Scenario 6c: Nvim scroll performance', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate a 500-line file with unique prefix per line
    await typeInTerminal(
      ctx.page,
      "seq 1 500 | awk '{printf \"LINE%03d quick brown fox\\n\", NR}' > /tmp/nvim-scroll.txt",
    );
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);

    // Open in nvim with minimal config
    await typeInTerminal(ctx.page, 'nvim --clean -n /tmp/nvim-scroll.txt');
    await pressEnter(ctx.page);
    // Wait for first line (LINE001) to appear
    await waitForTerminalText(ctx.page, 'LINE001', 15000);

    // Page down (Ctrl+D) multiple times and measure
    const scrollDownTime = await measureTime(async () => {
      for (let i = 0; i < 10; i++) {
        await ctx.page.keyboard.down('Control');
        await ctx.page.keyboard.press('d');
        await ctx.page.keyboard.up('Control');
        await delay(200);
      }
    });

    // Wait for content to settle after scrolling
    await delay(500);

    // Verify we scrolled: LINE001 should no longer be visible
    // Use exact prefix to avoid substring matches (LINE001 won't match LINE100 etc.)
    const afterDown = await getTerminalText(ctx.page);
    expect(afterDown).not.toContain('LINE001');

    // Page up (Ctrl+U) back
    const scrollUpTime = await measureTime(async () => {
      for (let i = 0; i < 10; i++) {
        await ctx.page.keyboard.down('Control');
        await ctx.page.keyboard.press('u');
        await ctx.page.keyboard.up('Control');
        await delay(200);
      }
    });

    // Verify we scrolled back to the top
    await waitForTerminalText(ctx.page, 'LINE001', 5000);

    // Generous thresholds: 10 scroll ops + 200ms delay each = ~2s minimum
    // Allow up to 10s for each direction (includes rendering + network)
    expect(scrollDownTime).toBeLessThan(10000);
    expect(scrollUpTime).toBeLessThan(10000);

    // Exit nvim
    await ctx.page.keyboard.type(':q!', { delay: 50 });
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.LONG);
  }, 60000);
});
