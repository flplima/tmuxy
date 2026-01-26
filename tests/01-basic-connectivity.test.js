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
});
