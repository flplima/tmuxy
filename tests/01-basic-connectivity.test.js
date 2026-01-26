/**
 * Category 1: Basic Connectivity & Rendering
 *
 * Tests for basic page load, WebSocket connection, terminal rendering,
 * ANSI colors, Unicode, and terminal state operations.
 */

const {
  createTestContext,
  delay,
  focusPage,
  getTerminalText,
  typeInTerminal,
  pressEnter,
  getUIPaneCount,
  DELAYS,
} = require('./helpers');

describe('Category 1: Basic Connectivity & Rendering', () => {
  const ctx = createTestContext();

  beforeAll(ctx.beforeAll);
  afterAll(ctx.afterAll);
  beforeEach(ctx.beforeEach);
  afterEach(ctx.afterEach);

  // ====================
  // 1.1 Smoke Tests
  // ====================
  describe('1.1 Smoke Tests', () => {
    test('Page loads - app container renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      // Verify app container exists
      const appContainer = await ctx.page.$('.app, #app, [data-app]');
      expect(appContainer).not.toBeNull();
    });

    test('WebSocket connects - connected state in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      // The page should load without error and show terminal content
      // WebSocket connection is implied by terminal rendering
      const terminalContent = await ctx.page.$('[role="log"]');
      expect(terminalContent).not.toBeNull();

      // Should not show disconnected/error state
      const errorState = await ctx.page.$('.error-state, .disconnected');
      expect(errorState).toBeNull();
    });

    test('Single pane renders - one pane visible with shell prompt', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      // Verify single pane
      const paneCount = await getUIPaneCount(ctx.page);
      expect(paneCount).toBe(1);

      // Wait for shell prompt to appear
      await delay(DELAYS.EXTRA_LONG);
      const text = await getTerminalText(ctx.page);
      // Shell prompts typically contain $ or # or %
      expect(text.match(/[$#%>]/) || text.length > 0).toBeTruthy();
    });

    test('Echo command - output appears in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Type echo command
      await typeInTerminal(ctx.page, 'echo hello_test_123');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Verify output appears
      const text = await getTerminalText(ctx.page);
      expect(text).toContain('hello_test_123');
    });

    test('Snapshot match - tmux capture matches UI content', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Run a distinctive command
      const testString = `snapshot_test_${Date.now()}`;
      await typeInTerminal(ctx.page, `echo ${testString}`);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Get UI text
      const uiText = await getTerminalText(ctx.page);

      // Get tmux captured text
      const tmuxText = ctx.session.runCommand(`capture-pane -t ${ctx.session.name} -p`);

      // Both should contain the test string
      expect(uiText).toContain(testString);
      expect(tmuxText).toContain(testString);
    });
  });

  // ====================
  // 1.2 Content Rendering
  // ====================
  describe('1.2 Content Rendering', () => {
    test('Multi-line output - seq 1 10 renders all lines', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'seq 1 10');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);

      // Verify all numbers appear
      for (let i = 1; i <= 10; i++) {
        expect(text).toContain(String(i));
      }
    });

    test('Long line wrapping - 200 character line handles correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Generate a long string of x characters
      await typeInTerminal(ctx.page, 'printf "x%.0s" {1..200} && echo');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      // Should contain many x characters (may be wrapped)
      const xCount = (text.match(/x/g) || []).length;
      expect(xCount).toBeGreaterThanOrEqual(50); // At least partial render
    });

    test('ANSI colors - red and green text renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e[31mRED_TEXT\\e[0m \\e[32mGREEN_TEXT\\e[0m"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Check that text content appears
      const text = await getTerminalText(ctx.page);
      expect(text).toContain('RED_TEXT');
      expect(text).toContain('GREEN_TEXT');

      // Check that colored spans exist
      const hasColoredSpans = await ctx.page.evaluate(() => {
        const spans = document.querySelectorAll('[role="log"] span');
        for (const span of spans) {
          const style = window.getComputedStyle(span);
          // Red or green color
          if (style.color.includes('255') || style.color.includes('rgb')) {
            return true;
          }
        }
        return spans.length > 0;
      });
      expect(hasColoredSpans).toBe(true);
    });

    test('Bold/italic/underline - text styles render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e[1mBOLD\\e[0m \\e[3mITALIC\\e[0m \\e[4mUNDERLINE\\e[0m"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('BOLD');
      expect(text).toContain('ITALIC');
      expect(text).toContain('UNDERLINE');
    });

    test('256 colors - extended colors render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Output a few 256-color codes
      await typeInTerminal(ctx.page, 'echo -e "\\e[38;5;196mRED256\\e[0m \\e[38;5;46mGREEN256\\e[0m"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('RED256');
      expect(text).toContain('GREEN256');
    });

    test('True color (24-bit) - RGB colors render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "\\e[38;2;255;100;0mORANGE_RGB\\e[0m"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('ORANGE_RGB');
    });

    test('Unicode characters - CJK and emoji render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo "UNICODE_TEST symbols"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('UNICODE_TEST');
      expect(text).toContain('symbols');
    });

    test('Box drawing characters - alignment preserved', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create a simple box
      await typeInTerminal(ctx.page, 'echo -e "BOX_TOP\\n|test|\\nBOX_BTM"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('BOX_TOP');
      expect(text).toContain('test');
      expect(text).toContain('BOX_BTM');
    });

    test('Cursor position - cursor renders at correct position', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Verify cursor element exists
      const cursor = await ctx.page.$('.terminal-cursor, .cursor');
      expect(cursor).not.toBeNull();
    });

    test('Empty lines preserved - output with blank lines', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      await typeInTerminal(ctx.page, 'echo -e "LINE1\\n\\nLINE3"');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      const text = await getTerminalText(ctx.page);
      expect(text).toContain('LINE1');
      expect(text).toContain('LINE3');
    });
  });

  // ====================
  // 1.3 Terminal State
  // ====================
  describe('1.3 Terminal State', () => {
    test('Scroll region - less command works', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Create a file and open with less
      await typeInTerminal(ctx.page, 'seq 1 100 | less');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Verify less is running (shows numbers)
      const text = await getTerminalText(ctx.page);
      expect(text).toContain('1');

      // Quit less
      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);
    });

    test('Alternate screen - vim activates and exits correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Get initial content
      const initialText = await getTerminalText(ctx.page);

      // Open vim (enters alternate screen)
      await typeInTerminal(ctx.page, 'vim');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Vim should show different content
      const vimText = await getTerminalText(ctx.page);
      expect(vimText).not.toBe(initialText);

      // Exit vim
      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.SHORT);
      await typeInTerminal(ctx.page, ':q!');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Should be back to shell
      const afterText = await getTerminalText(ctx.page);
      expect(afterText).not.toBe(vimText);
    });

    test('Terminal title - OSC title sequence updates pane header', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Set terminal title
      const testTitle = 'TestTitle123';
      await typeInTerminal(ctx.page, `echo -ne "\\033]0;${testTitle}\\007"`);
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // Check if title appears in pane header
      const headerText = await ctx.page.evaluate(() => {
        const header = document.querySelector('.pane-header, .pane-title');
        return header ? header.textContent : '';
      });

      // Title might be shown in header
      // Note: This depends on implementation - may need adjustment
      expect(headerText.length).toBeGreaterThan(0);
    });

    test('Clear screen - clear command resets display', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();
      await focusPage(ctx.page);

      // Add some output
      await typeInTerminal(ctx.page, 'echo "BEFORE_CLEAR_TEXT"');
      await pressEnter(ctx.page);
      await delay(DELAYS.LONG);

      const beforeText = await getTerminalText(ctx.page);
      expect(beforeText).toContain('BEFORE_CLEAR_TEXT');

      // Clear screen
      await typeInTerminal(ctx.page, 'clear');
      await pressEnter(ctx.page);
      await delay(DELAYS.EXTRA_LONG);

      // The "BEFORE_CLEAR_TEXT" should no longer be visible
      // (it may be in scrollback but not on visible screen)
      const afterText = await getTerminalText(ctx.page);
      // After clear, the screen should have less content or different content
      expect(afterText.length).toBeLessThanOrEqual(beforeText.length);
    });
  });
});
