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

    // Create a test file
    await typeInTerminal(ctx.page, 'echo "Hello from nvim test" > /tmp/nvim-test.txt');
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);

    // Open nvim with the file
    await typeInTerminal(ctx.page, 'nvim /tmp/nvim-test.txt');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, 'Hello from nvim test', 15000);

    // Verify normal mode: cursor should be block
    await waitForCursorClass(ctx.page, 'terminal-cursor-block');

    // Enter insert mode (press 'i')
    await ctx.page.keyboard.press('i');
    await delay(DELAYS.LONG);

    // Verify insert mode: cursor should be bar
    await waitForCursorClass(ctx.page, 'terminal-cursor-bar');

    // Type some text
    const insertedText = 'INSERTED_TEXT';
    await ctx.page.keyboard.type(insertedText, { delay: 30 });
    await waitForTerminalText(ctx.page, insertedText, 10000);

    // Return to normal mode (Escape)
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.LONG);

    // Verify cursor is back to block
    await waitForCursorClass(ctx.page, 'terminal-cursor-block');

    // Exit nvim (:q!)
    await ctx.page.keyboard.type(':q!', { delay: 30 });
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.LONG);

    // Verify shell prompt returns (look for $ or common prompt chars)
    const text = await getTerminalText(ctx.page);
    // After exiting nvim, the terminal should show the shell prompt
    // (the inserted text should NOT persist since we used :q!)
    expect(text).not.toContain(insertedText);
  }, 60000);

  test('Scenario 6b: Nvim typing performance', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Create a test file and open it in nvim
    await typeInTerminal(ctx.page, 'nvim /tmp/nvim-perf.txt');
    await pressEnter(ctx.page);
    await delay(2000); // Wait for nvim to fully load

    // Enter insert mode
    await ctx.page.keyboard.press('i');
    await delay(DELAYS.LONG);

    // Type a paragraph and measure time for it to appear
    const paragraph = 'The quick brown fox jumps over the lazy dog. Performance testing in progress.';
    const typeTime = await typeWithTiming(ctx.page, paragraph);

    // Wait for the text to appear in the terminal
    await waitForTerminalText(ctx.page, 'lazy dog', 10000);

    // Generous threshold: typing + round-trip should complete within 5s
    // The typeWithTiming itself is fast, but we also verify the text appeared
    expect(typeTime).toBeLessThan(5000);

    // Exit nvim
    await ctx.page.keyboard.press('Escape');
    await delay(DELAYS.SHORT);
    await ctx.page.keyboard.type(':q!', { delay: 30 });
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.LONG);
  }, 60000);

  test('Scenario 6c: Nvim scroll performance', async () => {
    if (ctx.skipIfNotReady()) return;
    await ctx.setupPage();

    // Generate a ~500 line file
    await typeInTerminal(
      ctx.page,
      'seq 1 500 | awk \'{print NR": The quick brown fox jumps over the lazy dog"}\' > /tmp/nvim-scroll.txt',
    );
    await pressEnter(ctx.page);
    await delay(DELAYS.LONG);

    // Open in nvim
    await typeInTerminal(ctx.page, 'nvim /tmp/nvim-scroll.txt');
    await pressEnter(ctx.page);
    await waitForTerminalText(ctx.page, '1: The quick brown fox', 15000);

    // Page down (Ctrl+D) multiple times and measure
    const scrollDownTime = await measureTime(async () => {
      for (let i = 0; i < 5; i++) {
        await ctx.page.keyboard.down('Control');
        await ctx.page.keyboard.press('d');
        await ctx.page.keyboard.up('Control');
        await delay(200);
      }
    });

    // Verify we scrolled (should see higher line numbers)
    const afterDown = await getTerminalText(ctx.page);
    // After 5 Ctrl+D presses, we should be well past line 1
    expect(afterDown).not.toContain('1: The quick brown fox');

    // Page up (Ctrl+U) back
    const scrollUpTime = await measureTime(async () => {
      for (let i = 0; i < 5; i++) {
        await ctx.page.keyboard.down('Control');
        await ctx.page.keyboard.press('u');
        await ctx.page.keyboard.up('Control');
        await delay(200);
      }
    });

    // Verify we scrolled back
    await waitForTerminalText(ctx.page, '1: The quick brown fox', 5000);

    // Generous thresholds: 5 scroll ops + 200ms delay each = ~1s minimum
    // Allow up to 8s for each direction (includes rendering + network)
    expect(scrollDownTime).toBeLessThan(8000);
    expect(scrollUpTime).toBeLessThan(8000);

    // Exit nvim
    await ctx.page.keyboard.type(':q!', { delay: 30 });
    await ctx.page.keyboard.press('Enter');
    await delay(DELAYS.LONG);
  }, 60000);
});
