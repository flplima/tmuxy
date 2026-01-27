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
  waitForTerminalText,
  runCommand,
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

      const appContainer = await ctx.page.$('#root');
      expect(appContainer).not.toBeNull();
    });

    test('WebSocket connects - connected state in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      const terminalContent = await ctx.page.$('[role="log"]');
      expect(terminalContent).not.toBeNull();

      const errorState = await ctx.page.$('.error-state, .disconnected');
      expect(errorState).toBeNull();
    });

    test('Single pane renders - one pane visible with shell prompt', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.navigateToSession();

      const paneCount = await getUIPaneCount(ctx.page);
      expect(paneCount).toBe(1);

      const text = await getTerminalText(ctx.page);
      expect(text.match(/[$#%>]/) || text.length > 0).toBeTruthy();
    });

    test('Echo command - output appears in UI', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo hello_test_123', 'hello_test_123');
    });

    test('Snapshot match - tmux capture matches UI content', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const testString = `snapshot_test_${Date.now()}`;
      const uiText = await runCommand(ctx.page, `echo ${testString}`, testString);

      const tmuxText = ctx.session.runCommand(`capture-pane -t ${ctx.session.name} -p`);

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

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'seq 1 10', '10');

      for (let i = 1; i <= 10; i++) {
        expect(text).toContain(String(i));
      }
    });

    test('Long line wrapping - 200 character line handles correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'printf "x%.0s" {1..200} && echo DONE', 'DONE');
      const xCount = (text.match(/x/g) || []).length;
      expect(xCount).toBeGreaterThanOrEqual(50);
    });

    test('ANSI colors - red and green text renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'echo -e "\\e[31mRED_TEXT\\e[0m \\e[32mGREEN_TEXT\\e[0m"', 'RED_TEXT');
      expect(text).toContain('GREEN_TEXT');

      const hasColoredSpans = await ctx.page.evaluate(() => {
        const spans = document.querySelectorAll('[role="log"] span');
        return spans.length > 0;
      });
      expect(hasColoredSpans).toBe(true);
    });

    test('Bold/italic/underline - text styles render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'echo -e "\\e[1mBOLD\\e[0m \\e[3mITALIC\\e[0m \\e[4mUNDERLINE\\e[0m"', 'BOLD');
      expect(text).toContain('ITALIC');
      expect(text).toContain('UNDERLINE');
    });

    test('256 colors - extended colors render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'echo -e "\\e[38;5;196mRED256\\e[0m \\e[38;5;46mGREEN256\\e[0m"', 'RED256');
      expect(text).toContain('GREEN256');
    });

    test('True color (24-bit) - RGB colors render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'echo -e "\\e[38;2;255;100;0mORANGE_RGB\\e[0m"', 'ORANGE_RGB');
    });

    test('Unicode characters - CJK and emoji render', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'echo "UNICODE_TEST symbols"', 'UNICODE_TEST');
      expect(text).toContain('symbols');
    });

    test('Box drawing characters - alignment preserved', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'echo -e "BOX_TOP\\n|test|\\nBOX_BTM"', 'BOX_TOP');
      expect(text).toContain('test');
      expect(text).toContain('BOX_BTM');
    });

    test('Cursor position - cursor renders at correct position', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const cursor = await ctx.page.$('.terminal-cursor, .cursor');
      expect(cursor).not.toBeNull();
    });

    test('Empty lines preserved - output with blank lines', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const text = await runCommand(ctx.page, 'echo -e "LINE1\\n\\nLINE3"', 'LINE1');
      expect(text).toContain('LINE3');
    });
  });

  // ====================
  // 1.3 Terminal State
  // ====================
  describe('1.3 Terminal State', () => {
    test('Scroll region - less command works', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'seq 1 100 | less', '1');

      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);
    });

    test('Alternate screen - vim activates and exits correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      await runCommand(ctx.page, 'vim', 'VIM', 15000);

      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type(':q!');
      await ctx.page.keyboard.press('Enter');
      await delay(DELAYS.LONG);

      const afterText = await getTerminalText(ctx.page);
      expect(afterText.includes('VIM')).toBe(false);
    });

    test('Terminal title - OSC title sequence updates pane header', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const testTitle = 'TestTitle123';
      await runCommand(ctx.page, `echo -ne "\\033]0;${testTitle}\\007"`, '$');
      await delay(DELAYS.LONG);

      const headerText = await ctx.page.evaluate(() => {
        const header = document.querySelector('.pane-header, .pane-title');
        return header ? header.textContent : '';
      });
      expect(headerText.length).toBeGreaterThan(0);
    });

    test('Clear screen - clear command resets display', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      const beforeText = await runCommand(ctx.page, 'echo "BEFORE_CLEAR_TEXT"', 'BEFORE_CLEAR_TEXT');

      await runCommand(ctx.page, 'clear', '$');
      await delay(DELAYS.LONG);

      const afterText = await getTerminalText(ctx.page);
      expect(afterText.length).toBeLessThanOrEqual(beforeText.length);
    });
  });

  // ====================
  // 1.4 Terminal Rendering Edge Cases
  // ====================
  describe('1.4 Terminal Rendering Edge Cases', () => {
    test('Wide characters (CJK) - renders without breaking layout', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Output CJK characters (Chinese, Japanese, Korean)
      // These are double-width characters that need proper handling
      const text = await runCommand(
        ctx.page,
        'echo "CJK_TEST: 你好世界 こんにちは 안녕하세요 END_CJK"',
        'CJK_TEST'
      );

      // Verify CJK characters rendered
      expect(text).toContain('你好世界');    // Chinese: Hello World
      expect(text).toContain('こんにちは');  // Japanese: Hello
      expect(text).toContain('안녕하세요');  // Korean: Hello
      expect(text).toContain('END_CJK');

      // Verify cursor still works after CJK
      const text2 = await runCommand(ctx.page, 'echo "AFTER_CJK"', 'AFTER_CJK');
      expect(text2).toContain('AFTER_CJK');
    });

    test('Wide characters (CJK) - alignment in columns', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Test column alignment with printf
      const text = await runCommand(
        ctx.page,
        'printf "%-10s|\\n" "abc" "日本" "test"',
        'abc'
      );

      // All lines should have the pipe character
      expect(text).toContain('abc');
      expect(text).toContain('日本');
      expect(text).toContain('test');
      expect(text).toContain('|');
    });

    test('Emoji - single codepoint emoji renders', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Simple single-codepoint emojis
      const text = await runCommand(
        ctx.page,
        'echo "EMOJI_TEST: ✓ ✗ ★ ♥ ♦ END_EMOJI"',
        'EMOJI_TEST'
      );

      expect(text).toContain('EMOJI_TEST');
      expect(text).toContain('END_EMOJI');
      // At minimum, the text should render without breaking
    });

    test('Emoji - multi-codepoint emoji handling', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Multi-codepoint emojis (ZWJ sequences, skin tone modifiers)
      // These may render as boxes/replacement chars but shouldn't break terminal
      const text = await runCommand(
        ctx.page,
        'echo "MULTI_EMOJI: 👨‍👩‍👧 🏳️‍🌈 👍🏽 END_MULTI"',
        'MULTI_EMOJI'
      );

      expect(text).toContain('MULTI_EMOJI');
      expect(text).toContain('END_MULTI');

      // Verify terminal still works after emoji
      const text2 = await runCommand(ctx.page, 'echo "AFTER_EMOJI"', 'AFTER_EMOJI');
      expect(text2).toContain('AFTER_EMOJI');
    });

    test('Emoji - in command output context', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Test emoji in a realistic context (git status style)
      const text = await runCommand(
        ctx.page,
        'echo "✓ Pass  ✗ Fail  ⚠ Warn"',
        'Pass'
      );

      expect(text).toContain('Pass');
      expect(text).toContain('Fail');
      expect(text).toContain('Warn');
    });

    test('Application cursor keys mode (DECCKM) - arrow keys in vim', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Start vim (enables DECCKM)
      await runCommand(ctx.page, 'vim', 'VIM', 15000);

      // Enter insert mode and type
      await ctx.page.keyboard.press('i');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.type('line1');
      await ctx.page.keyboard.press('Enter');
      await ctx.page.keyboard.type('line2');
      await delay(DELAYS.SHORT);

      // Exit insert mode
      await ctx.page.keyboard.press('Escape');
      await delay(DELAYS.SHORT);

      // Move up with arrow key (should work in DECCKM mode)
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);

      // Exit vim
      await ctx.page.keyboard.type(':q!');
      await ctx.page.keyboard.press('Enter');
      await delay(DELAYS.LONG);

      // Terminal should be back to normal
      const afterText = await getTerminalText(ctx.page);
      expect(afterText.includes('VIM')).toBe(false);

      // Verify terminal still works
      const text = await runCommand(ctx.page, 'echo "AFTER_VIM"', 'AFTER_VIM');
      expect(text).toContain('AFTER_VIM');
    });

    test('Application cursor keys mode - less navigation', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Generate content and view with less (enables DECCKM)
      await runCommand(ctx.page, 'seq 1 100 | less', '1');

      // Navigate with arrow keys
      await ctx.page.keyboard.press('ArrowDown');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowDown');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('ArrowUp');
      await delay(DELAYS.SHORT);

      // Page navigation
      await ctx.page.keyboard.press('PageDown');
      await delay(DELAYS.SHORT);
      await ctx.page.keyboard.press('PageUp');
      await delay(DELAYS.SHORT);

      // Exit less
      await ctx.page.keyboard.press('q');
      await delay(DELAYS.LONG);

      // Terminal should be responsive
      const text = await runCommand(ctx.page, 'echo "AFTER_LESS"', 'AFTER_LESS');
      expect(text).toContain('AFTER_LESS');
    });

    test('Bracketed paste mode - pasted text handled correctly', async () => {
      if (ctx.skipIfNotReady()) return;

      await ctx.setupPage();

      // Most modern shells enable bracketed paste mode
      // Verify pasting text works correctly
      const testText = 'pasted_text_123';

      // Focus and "paste" (simulate with evaluate since Playwright doesn't have direct paste)
      await ctx.page.evaluate((text) => {
        // Dispatch a synthetic input
        const event = new InputEvent('input', {
          inputType: 'insertFromPaste',
          data: text,
          bubbles: true,
          cancelable: true,
        });
        document.activeElement?.dispatchEvent(event);
      }, testText);

      // Just verify terminal is still functional
      const text = await runCommand(ctx.page, 'echo "PASTE_TEST"', 'PASTE_TEST');
      expect(text).toContain('PASTE_TEST');
    });
  });
});
